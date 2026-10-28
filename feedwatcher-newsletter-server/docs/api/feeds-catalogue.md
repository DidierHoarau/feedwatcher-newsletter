# Feed catalogue (`GET /api/feeds`)

`GET /api/feeds` is the stable, machine-readable contract for the newsletter
feeds this service offers. A reader (FeedWatcher or any other) can discover
every feed and subscribe to it without parsing the HTML index or importing
OPML.

## Authentication

`/api/feeds` is registered in the same access-control scope as `/rss/*`,
`/` and `/view/*`. When `AUTH_PASSWORD` is non-empty, every request needs HTTP
Basic credentials (`AUTH_USERNAME`, default `feedwatcher`) and returns `401`
otherwise. `/api/status` stays unauthenticated for readiness probes.

## Example payload

```json
{
  "version": 1,
  "feeds": [
    {
      "feedId": "morningbrew",
      "title": "Morning Brew",
      "senderName": "Morning Brew",
      "senderEmail": "brew@morningbrew.com",
      "itemCount": 12,
      "latestDate": "2026-10-16T08:00:00.000Z",
      "feedUrl": "https://feedwatcher-newsletter.example.com/rss/morningbrew.9f86d081884c7d65"
    },
    {
      "feedId": "thedaily",
      "title": "The Daily",
      "senderName": "The Daily",
      "senderEmail": "news@example.com",
      "itemCount": 3,
      "latestDate": "2026-10-16T08:00:00.000Z",
      "feedUrl": "https://feedwatcher-newsletter.example.com/rss/thedaily.2b7d1e35f0c94a18"
    }
  ]
}
```

## Fields

| Field         | Type   | Description |
| ------------- | ------ | ----------- |
| `version`     | number | Catalogue contract version, currently `1`. |
| `feeds`       | array  | Every offered feed, deterministically ordered. |
| `feedId`      | string | Stable key derived from the sender (or `FEED_OVERRIDES`). Unchanged when a private token rotates. |
| `title`       | string | Feed title: the `FEED_OVERRIDES` title when configured, otherwise the sender name. |
| `senderName`  | string | Sender display name of the feed's latest email. |
| `senderEmail` | string | Sender address of the feed's latest email. |
| `itemCount`   | number | Number of retained emails in the feed. |
| `latestDate`  | string | `dateReceived` of the latest retained email, ISO‑8601. |
| `feedUrl`     | string | Currently advertised feed URL (`/rss/<feedId>` or `/rss/<feedId>.<token>`). |

Ignored senders (`SENDER_IGNORE_LIST`) and emails without a usable sender are
never listed.

## Versioning rule

`version` is the contract version. Additive changes (a new field) keep the
version; removing or renaming a field, or changing its type, bumps it. A
consumer should check `version` and ignore fields it does not know.

## Ordering

Feeds are ordered by `(title, feedId)` using a locale-aware comparison of the
title and a `feedId` tie-break. The order is deterministic: identical content
produces a byte-identical body.

## Conditional requests and caching

The response carries a strong `ETag` (a hash of the body), `Last-Modified` and
`Cache-Control: private, no-cache`, and answers `If-None-Match` /
`If-Modified-Since` with `304 Not Modified`. Validators change on append,
purge and feed-identity (configuration) changes, so pollers revalidate instead
of re-downloading unchanged catalogues. Responses are compressed with
gzip/brotli when the client advertises support and the body exceeds 1 KiB.

## Relation to the other representations

- `GET /rss/` with `Accept: text/html` is the human index page; it advertises
  one `<link rel="alternate" type="application/rss+xml">` per feed for reader
  autodiscovery and is served with `Referrer-Policy: no-referrer`, so tokens
  cannot leak through referrers.
- `GET /rss/` without `Accept: text/html` is the legacy JSON array. It keeps
  its `id`, `senderName`, `senderEmail` and `feedUrl` keys and additionally
  exposes `feedId`, `title`, `itemCount` and `latestDate`. New consumers
  should prefer `/api/feeds`, which is the versioned contract.
- `GET /rss/opml` exports the same feeds as OPML 2.0, grouped under a
  `Newsletters` folder outline, ordered by `(title, feedId)`.

`feedId`, `title` and `itemCount` are the same values in every representation.

## Identity, overrides and private URLs

- `FEED_OVERRIDES` maps a sender email or name to a stable `feedId` and/or
  `title`. Use it when a newsletter renames itself or when several senders
  should merge into one feed.
- `FEED_PRIVATE_URLS` (default `true`) makes `feedUrl` a capability URL of the
  form `/rss/<feedId>.<token>`. Treat those URLs as secrets: anyone holding
  one can read the feed.
- `FEED_PRIVATE_URLS_STRICT` (default `false`) rejects bare `<feedId>` URLs
  with `404`; only tokenized URLs are served.
- Tokens may rotate (they are persisted in `DATA_DIR/feed-tokens.json`), but
  `feedId` does not. Consumers should key stored subscriptions on `feedId` and
  refresh `feedUrl` from this catalogue instead of persisting the URL as the
  identity.
- When `PUBLIC_URL` is set, it is authoritative for `feedUrl`. Otherwise the
  URL is derived from the request (`Host`, protocol), so configure a
  `PUBLIC_URL` in production and use `TRUST_PROXY` only behind a trusted
  reverse proxy.

## Example

```bash
curl -u feedwatcher:secret -H 'Accept: application/json' \
  https://feedwatcher-newsletter.example.com/api/feeds
```
