# Feed settings (`/api/feeds/settings`, `/manage`)

Feed settings are the self-service curation layer: rename, hide, merge or
split feeds without touching the email journal, `FEED_OVERRIDES` or feed
tokens. They are stored in `DATA_DIR/feed-settings.json`, applied immediately
and hot-reloaded, and exposed through a JSON API and a server-rendered form.

Authentication matches the rest of the product: when `AUTH_PASSWORD` is
non-empty, `/manage`, `GET /api/feeds/settings`, `PUT /api/feeds/settings` and
the other content pages (including `/status`) require HTTP Basic credentials.
`/api/status` stays open.

## Document

```json
{
  "version": 1,
  "feeds": {
    "thedaily": {
      "title": "The Daily Brief",
      "hidden": false,
      "maxItems": 50,
      "blockRemoteImages": true,
      "stripTrackingPixels": true,
      "mergeInto": "news-roundup"
    },
    "news-roundup": { "title": "All News" }
  },
  "senders": {
    "alerts@scmp.com": { "feedId": "scmp", "title": "South China Morning Post" }
  }
}
```

| Field | Type | Description |
| ----- | ---- | ----------- |
| `version` | number | Contract version, currently `1`. Omitted means `1`; any other value is rejected on write and ignored (keeping the previous settings) on read. |
| `feeds` | object | Keyed by **base feed id** (the derived id or the `FEED_OVERRIDES` id, before any merge). |
| `feeds.<id>.title` | string | Per-feed title override, 1–200 characters after whitespace/control-character normalization. Wins over `FEED_OVERRIDES` and the sender name. |
| `feeds.<id>.hidden` | boolean | Remove the feed from the index, OPML, catalogue, `/rss/:id`, `/rss/:id/archive` and `/view` navigation. No data is deleted. |
| `feeds.<id>.maxItems` | non-negative integer | Per-feed RSS window; `0` = unlimited. Overrides `FEED_MAX_ITEMS`. The archive still lists every retained email. |
| `feeds.<id>.blockRemoteImages` | boolean | Per-feed override of `EMAIL_BLOCK_REMOTE_IMAGES` for feed items and `/view` pages. |
| `feeds.<id>.stripTrackingPixels` | boolean | Per-feed override of `EMAIL_STRIP_TRACKING_PIXELS`. |
| `feeds.<id>.mergeInto` | string | Merge this base feed into another feed id. Must be a different valid feed id; transitive. |
| `senders` | object | Exact sender email or name (case-insensitive, trimmed, 1–320 characters) → `{ "feedId"?, "title"? }`. |
| `senders.<match>.feedId` | string | Stable feed id for this sender; splits senders that normalize to the same id. |
| `senders.<match>.title` | string | Title override for this sender. |

All fields are optional. An omitted field inherits the environment
(`FEED_MAX_ITEMS`, `EMAIL_BLOCK_REMOTE_IMAGES`, `EMAIL_STRIP_TRACKING_PIXELS`)
or the identity defaults. Feed ids must match `^[a-z0-9][a-z0-9-]{0,63}$`.

`SENDER_IGNORE_LIST` remains an ingestion-time setting: ignored emails are not
stored at all, so no feed-settings rule can resurrect them.

## Precedence

For each sender, from highest to lowest:

1. `feed-settings.json` sender rule (`senders` keyed by exact email or name;
   email is checked before name).
2. `FEED_OVERRIDES` (environment).
3. Derived id (`lowercased` alphanumeric name, or `sender-<8 hex>` fallback)
   and the sender name as title.

For a final feed: `feeds.<finalId>.title` / `maxItems` / privacy flags override
the environment values. The per-feed title applies to the final id (the merge
target for a merged feed).

## Hidden feeds

`hidden: true` keeps the journal, the feed token and the settings entry, but
the feed disappears from:

- the `/rss/` HTML index and JSON list, `/rss/opml`, `GET /api/feeds`;
- `/rss/:id` and `/rss/:id/archive`, which return `404`;
- `/view/:emailId` navigation (the permalink page itself keeps working).

Unhiding restores the same URL, including its existing token.

## Merging feeds

`mergeInto` folds a source feed's emails into the target feed:

- The target's `/rss/:id` serves the union of its own and its sources' items,
  newest first; `itemCount` and `servedItemCount` reflect the union.
- A request for the source feed (and its archive) redirects with `302` to the
  target's tokenized URL (or bare URL when private URLs are disabled),
  transitively through the chain.
- Hidden wins: a hidden source stays hidden, and a hidden final target makes
  every source return `404`. A source whose target is hidden is not listed.
- Cycles, self-merges and chains longer than 16 links are rejected on write;
  on a hand-edited file, the offending `mergeInto` edges are dropped.
- Feed tokens of sources and targets are preserved, so unmerging restores the
  previous subscription URL.

## Persistence and reload

- The file is replaced atomically (temporary file, fsync, rename), like
  `feed-tokens.json`; a crash never leaves a truncated document.
- `DATA_DIR/feed-settings.json` is watched (1 s poll) and applied immediately.
- Writes through the API/UI validate strictly first: any error rejects the
  whole document (`400`) and leaves both the file and the applied settings
  unchanged.
- A hand-edited file is read leniently: invalid entries, fields, ids, hits and
  merge cycles are dropped with a warning, the rest is applied. Invalid JSON or
  an unsupported `version` keeps the last applied settings; deleting the file
  resets to the empty defaults.
- `/data` must be a persistent volume, like the rest of the service state.

## JSON API

### `GET /api/feeds/settings`

Returns the normalized document. `Cache-Control: no-store`.

```bash
curl -u feedwatcher:secret \
  https://feedwatcher-newsletter.example.com/api/feeds/settings
```

### `PUT /api/feeds/settings`

Replaces the whole document. Required headers:

- `Content-Type: application/json` — otherwise `415`.
- `X-Feedwatcher-Csrf: 1` — otherwise `403`. A cross-site HTML form cannot set
  a custom header, so this makes the write CSRF-safe even when authentication
  is disabled.

A valid document returns `200` with the normalized document and is persisted
and applied immediately. Validation errors return `400`:

```json
{
  "error": "Invalid feed settings",
  "details": ["feeds.Bad.Id: invalid feed id", "feeds.daily.maxItems: must be a non-negative integer"]
}
```

A storage failure returns `500` and leaves the previous document active.

```bash
curl -u feedwatcher:secret \
  -X PUT \
  -H 'Content-Type: application/json' \
  -H 'X-Feedwatcher-Csrf: 1' \
  --data '{"version":1,"feeds":{"thedaily":{"hidden":true}}}' \
  https://feedwatcher-newsletter.example.com/api/feeds/settings
```

## `/manage`

`GET /manage` is a server-rendered form (HTML, no JavaScript, no feed tokens)
listing every base feed (including hidden and merged sources) and the sender
rules. It never renders credentials or capability URLs.

`POST /manage` accepts the form as
`application/x-www-form-urlencoded` and requires the hidden `csrf` field that
`GET /manage` embedded. A missing or wrong token returns `403`. A validation
error re-renders the page with `400` and an escaped message; a successful save
redirects (`303`) to `/manage?saved=1`.

The form token is generated per process, so the form UI targets a
single-instance deployment. Multi-replica deployments should write through the
stateless JSON API instead.
