# FeedWatcher Newsletter

FeedWatcher Newsletter is a server-only service that connects to an IMAP mailbox, retrieves newsletter emails, and exposes each sender's emails as an individual RSS feed. It is designed to bridge email newsletters into any RSS reader, including [FeedWatcher](https://github.com/didierhoarau/feedwatcher).

# Philosophy

This project is a server-only companion to FeedWatcher. It has no UI and requires no external database. Emails are stored on disk as an append-only JSON-lines journal (`emails.jsonl`, migrated automatically from the legacy `emails.json` array) and automatically purged after a configurable retention period. The goal is a lightweight, self-contained service that converts an email inbox into subscribable RSS feeds.

One RSS feed is generated per unique sender name. Each feed's items are the email bodies (HTML preferred, plain text fallback) from that sender, ordered by date received.

Email bodies are sanitized when served (scripts, event handlers, dangerous URLs and tracking pixels are stripped), each item links to a readable web view of the email, and feeds advertise near-real-time ingestion via IMAP IDLE with the cron schedule as fallback. Feed URLs can carry a per-feed token, senders can be ignored or renamed via configuration, and all feeds are discoverable through the versioned JSON catalogue (`/api/feeds`), advertised for reader autodiscovery on the index page, and importable anywhere through OPML export. Tokenized URLs only obfuscate feed addresses; the service has no authentication by default — see [Security and privacy](#security-and-privacy).

# Deployment

FeedWatcher Newsletter is designed to be deployed as a container.

- This image exposes port `8080`
- The data volume is located at `/data`
- The container runs as the unprivileged `node` user (uid 1000); `/data` must be writable by that user (the image creates and owns it by default)
- The runtime image contains production dependencies only (`npm prune --omit=dev`) and ships the CA certificates required for IMAP TLS verification

## Docker

```bash
mkdir -p data
docker run --name feedwatcher-newsletter \
  -p 8080:8080 \
  -v "$(pwd)/data:/data" \
  -e IMAP_HOST=imap.example.com \
  -e IMAP_USER=newsletter@example.com \
  -e IMAP_PASSWORD=yourpassword \
  -e IMAP_MAILBOX=INBOX \
  -d feedwatcher-newsletter
```

## Kubernetes

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: feedwatcher-newsletter
  labels:
    app: feedwatcher-newsletter
spec:
  replicas: 1
  selector:
    matchLabels:
      app: feedwatcher-newsletter
  template:
    metadata:
      labels:
        app: feedwatcher-newsletter
    spec:
      containers:
        - image: feedwatcher-newsletter
          name: feedwatcher-newsletter
          env:
            - name: IMAP_HOST
              valueFrom:
                secretKeyRef:
                  name: feedwatcher-newsletter-secret
                  key: IMAP_HOST
            - name: IMAP_USER
              valueFrom:
                secretKeyRef:
                  name: feedwatcher-newsletter-secret
                  key: IMAP_USER
            - name: IMAP_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: feedwatcher-newsletter-secret
                  key: IMAP_PASSWORD
          resources:
            limits:
              memory: 256Mi
              cpu: 500m
            requests:
              memory: 128Mi
              cpu: 50m
          readinessProbe:
            httpGet:
              path: /api/status
              port: 8080
            initialDelaySeconds: 5
            periodSeconds: 10
            failureThreshold: 3
---
apiVersion: v1
kind: Service
metadata:
  name: feedwatcher-newsletter
spec:
  ports:
    - name: tcp
      port: 8080
      targetPort: 8080
  selector:
    app: feedwatcher-newsletter
```

# Security and privacy

By default the service has **no authentication**: anyone who can reach the host can list the feeds (`/api/feeds` catalogue, `/rss/` HTML index and JSON list), fetch any feed and open any email at `/view/:emailId`. `FEED_PRIVATE_URLS` only obfuscates feed URLs (`<feedId>.<token>`): the index, the catalogue and the OPML export publish those URLs to every caller, and bare feed ids keep working unless strict private mode is enabled. Treat tokenized URLs as a convenience, not as access control. `SENDER_IGNORE_LIST` is enforced on every read path, so ignored senders are never listed and their feeds and permalinks are never served.

IMAP connections verify the server certificate by default (see [IMAP](#imap)). HTML pages are served with a Content-Security-Policy (hash-based for the inline copy script, so ETag/304 caching still works) and every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY` and a restrictive `Permissions-Policy`. RSS, JSON, catalogue and OPML payloads get the same baseline headers without the CSP; the global `no-referrer` policy prevents feed tokens from leaking through referrers when readers follow the autodiscovery links.

## Dependency audit

`npm audit --omit=dev` is a blocking CI gate on pull requests and on main: an unallowlisted high or critical production advisory fails the build. Exceptions, if ever needed, go to `.github/audit-allowlist.json` with an advisory id, package, scope, expiry date, reason and owner. The IMAP client is the maintained `imapflow`; the transitive `follow-redirects` and `source-map-js` versions are pinned through `overrides` in `feedwatcher-newsletter-server/package.json`.

## HTTP Basic authentication (optional)

Set `AUTH_PASSWORD` (and optionally `AUTH_USERNAME`, default `feedwatcher`) to require HTTP Basic credentials on `/`, `/rss/*`, `/view/*` and `/api/feeds`. `/api/status` stays open for readiness probes. Authentication is disabled while `AUTH_PASSWORD` is empty, so an unchanged deployment keeps serving existing subscribers. Configure every feed reader (and browser) with the same credentials, and only send them over HTTPS. The password is registered as sensitive and masked in configuration logs; `AUTH_USERNAME` and `AUTH_PASSWORD` are applied on hot configuration reload.

## Strict private mode (optional)

With `FEED_PRIVATE_URLS=true` and `FEED_PRIVATE_URLS_STRICT=true`, requests using a bare feed id are rejected with `404`; only `<feedId>.<token>` URLs are served. This is opt-in because bare-id subscriptions stop working: update every reader to the tokenized URLs advertised by `/rss/` before enabling it. Strict mode does not replace authentication — it only makes URLs harder to guess.

## Feed URLs and proxies

`PUBLIC_URL` is authoritative for the URLs advertised by the index, the `/api/feeds` catalogue, the OPML export and the feed metadata. When it is empty, URLs are derived from the request: the `Host` header including its port, and the request protocol. Without `PUBLIC_URL` the `Host` header is client-controlled, so a caller can poison the URLs it receives. Behind a trusted reverse proxy, set `TRUST_PROXY=true` (restart-only) so `X-Forwarded-Proto`/`X-Forwarded-Host` are used; leave it `false` otherwise.

# Configuration

Configuration values can be set via environment variables or through the `config.json` file. Environment variables take precedence over config file values, which take precedence over defaults.

## IMAP

| Variable        | Description                        | Default |
| --------------- | ---------------------------------- | ------- |
| `IMAP_HOST`     | IMAP server hostname               |         |
| `IMAP_PORT`     | IMAP server port                   | `993`   |
| `IMAP_TLS`      | Enable TLS for the IMAP connection | `true`  |
| `IMAP_USER`     | IMAP account username              |         |
| `IMAP_PASSWORD` | IMAP account password              |         |
| `IMAP_MAILBOX`  | Mailbox folder to read emails from | `INBOX` |
| `IMAP_TLS_INSECURE` | **Unsafe.** Disable TLS certificate verification for the IMAP server (the server identity is then not authenticated). Restart-only. | `false` |
| `IMAP_TLS_CA_FILE` | Path to an extra PEM CA bundle trusted in addition to the system/public roots, e.g. for a self-hosted server with a private CA. Restart-only. | `` (empty) |
| `IMAP_SOCKET_TIMEOUT_MS` | Socket inactivity timeout for fetch connections in milliseconds (`0` disables) | `120000` |
| `IMAP_IDLE_SOCKET_TIMEOUT_MS` | Socket inactivity timeout for the IDLE connection in milliseconds; must exceed the 300 s IDLE keepalive (`0` disables) | `600000` |

The IMAP server certificate is verified against the system CA store by default (`node:24-alpine` plus the `ca-certificates` package in the image). Keep verification enabled: `IMAP_TLS_INSECURE=true` is the only, deliberately loud, way to bypass it and should only be used temporarily for a server whose certificate cannot be fixed. TLS failures are logged with an actionable hint and never trigger a silent fallback to an unverified connection.

## General

| Variable                   | Description                                                                   | Default                 |
| -------------------------- | ----------------------------------------------------------------------------- | ----------------------- |
| `PUBLIC_URL`               | Public base URL of the service (used in feed URLs; empty = from the request)  | `` (empty)              |
| `TRUST_PROXY`              | Trust `X-Forwarded-Proto`/`X-Forwarded-Host` from a reverse proxy (restart-only, see [Feed URLs and proxies](#feed-urls-and-proxies)) | `false` |
| `EMAIL_FETCH_CRON`         | Cron expression for the email fetch schedule (fallback for IMAP IDLE)         | `0 * * * *` (hourly)    |
| `EMAIL_RETENTION_DAYS`     | Number of days to retain emails before purging                                | `3`                     |
| `DATA_DIR`                 | Directory for persisting email data                                           | `/data`                 |

## Fetching and freshness

| Variable                     | Description                                                                        | Default |
| ---------------------------- | ---------------------------------------------------------------------------------- | ------- |
| `EMAIL_FETCH_BATCH_SIZE`     | Max emails per IMAP fetch batch                                                    | `200`   |
| `EMAIL_FETCH_RUN_BUDGET`     | Max emails processed within a single run, across successive batches (catch-up)     | `2000`  |
| `EMAIL_FETCH_IDLE`           | Keep a long-lived IMAP connection for near-real-time ingestion (IMAP IDLE)         | `true`  |
| `EMAIL_FETCH_RETRIES`        | Retry attempts for transient IMAP failures within one cycle                        | `2`     |
| `EMAIL_FETCH_RETRY_DELAY_MS` | Delay between retry attempts in milliseconds                                       | `10000` |
| `EMAIL_FETCH_DEADLINE_MS`    | Overall deadline for one fetch run in milliseconds; a stalled connection is aborted (`0` disables) | `300000` |

## Content and feeds

| Variable                      | Description                                                                        | Default |
| ----------------------------- | ---------------------------------------------------------------------------------- | ------- |
| `EMAIL_STRIP_TRACKING_PIXELS` | Strip tracking-pixel images (1x1, or a single known dimension ≤ 1) from email bodies; `false` keeps them | `true`  |
| `FEED_PRIVATE_URLS`           | Advertise tokenized feed URLs (`<feedId>.<token>`); bare feed ids keep working unless `FEED_PRIVATE_URLS_STRICT=true` | `true`  |
| `FEED_PRIVATE_URLS_STRICT`    | With `FEED_PRIVATE_URLS=true`, reject bare feed ids with `404` (opt-in; bare-id subscriptions stop working) | `false` |
| `SENDER_IGNORE_LIST`          | Comma-separated sender name/email fragments whose emails never become feeds        | `` (empty)              |
| `FEED_OVERRIDES`              | JSON object mapping a sender email or name to a stable feed id and/or title        | `{}`    |

## Access control

| Variable        | Description                                                                  | Default          |
| --------------- | ---------------------------------------------------------------------------- | ---------------- |
| `AUTH_USERNAME` | HTTP Basic username required when authentication is enabled                  | `feedwatcher`    |
| `AUTH_PASSWORD` | HTTP Basic password; empty disables authentication (sensitive, masked in logs) | `` (empty)     |

When authentication is enabled (non-empty `AUTH_PASSWORD`), every endpoint except `/api/status` returns `401` without valid Basic credentials — see [Security and privacy](#security-and-privacy).

`FEED_OVERRIDES` example (stabilizes identity when a newsletter renames itself, merges senders into one feed, or renames a feed):

```json
{
  "FEED_OVERRIDES": {
    "alerts@scmp.com": { "feedId": "scmp", "title": "South China Morning Post" }
  }
}
```

## Reliability

- **Durable ingestion.** Journal appends are fsync'd before they are considered successful. A failed journal write fails the fetch run and leaves the UID marker untouched, so the emails are fetched again on the next run instead of being lost.
- **Resume marker and UIDVALIDITY.** The resume state lives in `DATA_DIR/last-uid.json` as `{ "uid": ..., "uidvalidity": ... }`. The mailbox UIDVALIDITY is compared on every connection: when it changes (mailbox recreated or migrated), the marker is reset with a warning and the mailbox is re-scanned from UID 1. Existing journal items are kept; message-id deduplication prevents duplicates and retention applies to old items. A legacy `last-uid.txt` marker is imported once (with an unknown UIDVALIDITY that is adopted from the server without resetting the UID) and left in place.
- **Single-flight fetch.** Startup, cron and IMAP IDLE triggers share one guard: a trigger arriving while a fetch is in progress is skipped (and logged), so runs never overlap and cannot move the marker backwards.
- **Timeouts.** Fetch connections use `IMAP_SOCKET_TIMEOUT_MS`, the IDLE connection uses `IMAP_IDLE_SOCKET_TIMEOUT_MS`, and every fetch run has an overall `EMAIL_FETCH_DEADLINE_MS` deadline. A connection that ends or closes mid-fetch settles the run instead of hanging it.
- **Safe purge.** The hourly purge aborts without touching the journal when it cannot read it completely, and rewrites through an fsync'd temporary file followed by a rename, so the journal is never truncated.

## Performance and HTTP caching

- **In-memory index.** `emails.jsonl` remains the single source of truth, but it is parsed once at startup into an in-memory index (current record per message id, item id → record, journal record counts). Appends and purges update the index write-through and feed grouping is derived lazily in memory, so `/rss/`, `/rss/opml` and `/rss/:id` never read the journal during a request. An unreadable journal fails the startup instead of silently serving empty feeds. Memory follows the journal size: a ~96 MB journal indexes to roughly 340 MB RSS after startup.
- **Sanitized-body cache.** Sanitized HTML and its plain-text summary are cached per item id and sanitizer configuration in a bounded LRU of 32 MiB (accounted as raw UTF-16 size, evicted on purge and reset at startup). Feed builds and `/view/:emailId` share the cache, so a body is sanitized once per configuration instead of on every poll.
- **Conditional requests.** `/rss/` (JSON and HTML), `/rss/opml`, `/rss/:id` and `/api/feeds` return a strong `ETag` (content hash) and `Last-Modified`, both invalidated by append, purge and feed-identity changes, and answer `If-None-Match`/`If-Modified-Since` with `304 Not Modified`. `/rss/` also sends `Vary: Accept`.
- **Compression.** gzip, brotli and deflate are negotiated for `/rss/*` and the HTML pages; responses below 1 KiB stay identity-encoded, and a request without `Accept-Encoding` gets the identity representation (`Vary: Accept-Encoding`).
- **Benchmark.** `feedwatcher-newsletter-server/docs/bench/feed-serving-benchmark.ts` regenerates a synthetic journal (default: 1,000 records / ~96 MB / 50 feeds) and reports per-endpoint cold and warm latency plus RSS. Run it from `feedwatcher-newsletter-server/` with `npx tsx docs/bench/feed-serving-benchmark.ts --out after.json`; the measured before/after is in `docs/bench/README.md`.

## Configuration reload

`config.json` is watched and reloaded without a restart. These values are applied immediately: `EMAIL_FETCH_CRON` (the job is rescheduled), `EMAIL_RETENTION_DAYS`, `EMAIL_FETCH_IDLE` (the IDLE connection is started or stopped), `SENDER_IGNORE_LIST`, `FEED_OVERRIDES`, `FEED_PRIVATE_URLS`, `FEED_PRIVATE_URLS_STRICT`, `AUTH_USERNAME`, `AUTH_PASSWORD`, `PUBLIC_URL` and the `EMAIL_FETCH_*` knobs. These are **restart-only** (a warning is logged when they change): `IMAP_HOST`, `IMAP_PORT`, `IMAP_TLS`, `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_MAILBOX`, `IMAP_TLS_INSECURE`, `IMAP_TLS_CA_FILE`, `DATA_DIR`, `API_PORT`, `TRUST_PROXY` and the OpenTelemetry exporter settings. An unreadable or invalid `config.json` is ignored and the last valid configuration stays active.

## OpenTelemetry

| Variable                                                  | Description                                 | Default |
| --------------------------------------------------------- | ------------------------------------------- | ------- |
| `OPENTELEMETRY_COLLECTOR_HTTP_TRACES`                     | OTel collector URL for traces               |         |
| `OPENTELEMETRY_COLLECTOR_HTTP_METRICS`                    | OTel collector URL for metrics              |         |
| `OPENTELEMETRY_COLLECTOR_HTTP_LOGS`                       | OTel collector URL for logs                 |         |
| `OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS`    | Log export interval in seconds              | `60`    |
| `OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS` | Metrics export interval in seconds          | `60`    |
| `OPENTELEMETRY_COLLECTOR_AWS`                             | Enable AWS OTel collector                   | `false` |
| `OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER`              | Authorization header for the OTel collector |         |

Tracing covers the product routes: `/`, `/rss/*`, `/view/*` and `/api/feeds` produce an HTTP server span (`GET-<route>`), and each feed build runs inside it as a `RssFeedGeneratorBuildFeedById` child span. Requests that match no route are named by their method (`GET`) to keep span-name cardinality bounded. `/api/status` is excluded from tracing because the readiness probe pollutes the trace list with it. The service emits **no metrics**: the Fastify hooks are registered without a meter.

`service.version` is read from `feedwatcher-newsletter-server/package.json` (the runtime image ships that manifest), so traces, logs and metrics identify the application version rather than the installed shared library version. An explicit `VERSION` environment variable or config file value still overrides it.

# API

When authentication is enabled (`AUTH_PASSWORD` non-empty), every endpoint below requires HTTP Basic credentials and returns `401` otherwise; `/api/status` stays open for probes.

| Method | Path              | Description                                              |
| ------ | ----------------- | -------------------------------------------------------- |
| `GET`  | `/api/feeds`      | Versioned JSON feed catalogue — the stable contract for readers (see [Feed catalogue](#feed-catalogue-apifeeds)); protected when authentication is enabled |
| `GET`  | `/rss/`           | List all available RSS feeds — HTML index page (with reader autodiscovery links) for browsers, JSON array for API clients |
| `GET`  | `/rss/opml`       | OPML 2.0 export of all feeds, grouped under a `Newsletters` folder (importable into FeedWatcher and most RSS readers) |
| `GET`  | `/rss/:id`        | Get the RSS feed for a specific sender by sender ID; `404` for unknown feeds, invalid tokens and ignored senders |
| `GET`  | `/view/:emailId`  | Readable web view of one email (the feed items' permalink target); `404` for unknown or ignored emails |
| `GET`  | `/api/status`     | Unauthenticated readiness and ingestion health snapshot (see below); excluded from tracing |

The sender ID is derived from the sender name by lowercasing it and removing all non-alphanumeric characters (e.g., `"The Daily Newsletter"` → `thedailynewsletter`). It can be overridden per sender with `FEED_OVERRIDES`.

The feed list, the catalogue, the OPML export and every feed answer conditional requests: they carry an `ETag` and `Last-Modified` and return `304 Not Modified` for `If-None-Match`/`If-Modified-Since`, so pollers do not re-download unchanged feeds. Feed payloads and the HTML pages are compressed with gzip/brotli when the client advertises support; `Accept-Encoding`-less requests get the identity body. See [Performance and HTTP caching](#performance-and-http-caching).

When `FEED_PRIVATE_URLS` is enabled (default), the catalogue, the list and the OPML export advertise feed URLs of the form `<feedId>.<randomToken>` (e.g. `thedailynewsletter.9f86d081884c7d65`), persisted in `DATA_DIR/feed-tokens.json`. Tokens are created only for existing feeds, are pruned at startup when their feed disappears, and an invalid token never creates an entry. Bare feed ids keep working so existing reader subscriptions are unaffected, unless `FEED_PRIVATE_URLS_STRICT=true` is set — then bare ids return `404` and only tokenized URLs are served.

The `/rss/` JSON list keeps its legacy shape and additionally exposes the catalogue metadata; existing consumers are unaffected:

```json
[
  {
    "id": "thedailynewsletter",
    "feedId": "thedailynewsletter",
    "title": "The Daily Newsletter",
    "senderName": "The Daily Newsletter",
    "senderEmail": "news@example.com",
    "itemCount": 12,
    "latestDate": "2026-10-16T08:00:00.000Z",
    "feedUrl": "https://feedwatcher-newsletter.example.com/rss/thedailynewsletter.9f86d081884c7d65"
  }
]
```

The HTML index also advertises one `<link rel="alternate" type="application/rss+xml">` per feed, so a generic reader pointed at the root discovers every feed without parsing the page; the global `Referrer-Policy: no-referrer` keeps the tokenized URLs from leaking through referrers.

## Feed catalogue (`/api/feeds`)

`GET /api/feeds` is the stable, machine-readable contract for the offered feeds. It returns a versioned envelope:

```json
{
  "version": 1,
  "feeds": [
    {
      "feedId": "thedailynewsletter",
      "title": "The Daily Newsletter",
      "senderName": "The Daily Newsletter",
      "senderEmail": "news@example.com",
      "itemCount": 12,
      "latestDate": "2026-10-16T08:00:00.000Z",
      "feedUrl": "https://feedwatcher-newsletter.example.com/rss/thedailynewsletter.9f86d081884c7d65"
    }
  ]
}
```

| Field         | Description |
| ------------- | ----------- |
| `version`     | Contract version, currently `1`. Additive fields keep the version; removals, renames and type changes bump it. |
| `feedId`      | Stable key derived from the sender (or `FEED_OVERRIDES`); it does not change when a private token rotates. |
| `title`       | Override-aware feed title, falling back to the sender name. |
| `senderName` / `senderEmail` | Sender of the feed's latest retained email. |
| `itemCount`   | Number of retained emails in the feed. |
| `latestDate`  | `dateReceived` of the latest retained email, ISO-8601. |
| `feedUrl`     | Currently advertised feed URL (`/rss/<feedId>` or `/rss/<feedId>.<token>`). |

- **Ordering** is deterministic: `(title, feedId)`.
- **Auth scope** matches `/rss/*`: with `AUTH_PASSWORD` set the endpoint returns `401` without Basic credentials.
- **Conditional requests** are supported (`ETag`, `Last-Modified`, `304`, `Cache-Control: private, no-cache`).
- **Consumers should key on `feedId`**, not on `feedUrl`: private URLs are capability URLs that may rotate, and `FEED_PRIVATE_URLS_STRICT=true` rejects bare ids. Refresh `feedUrl` from the catalogue instead of persisting it as the identity. Set `PUBLIC_URL` so catalogue URLs do not depend on the request `Host`.

The full contract (fields, versioning rule, overrides, private-URL modes) is documented in [`feedwatcher-newsletter-server/docs/api/feeds-catalogue.md`](feedwatcher-newsletter-server/docs/api/feeds-catalogue.md).

## Status

`GET /api/status` is unauthenticated (the Kubernetes readiness probe calls it every 10 s) and returns an in-memory snapshot of the ingestion health without any credentials or email content:

```json
{
  "started": true,
  "lastSuccessfulFetchAt": "2026-10-23T05:00:12.345Z",
  "lastUid": 1234,
  "uidvalidity": 7,
  "recordCount": 42,
  "idle": { "enabled": true, "connected": true },
  "lastError": null
}
```

- `lastSuccessfulFetchAt` and `lastError` are in-memory and reset on restart; `lastError` is reduced to one line and truncated to 500 characters (no stacks).
- `lastUid`/`uidvalidity` mirror the durable resume marker `DATA_DIR/last-uid.json`.
- `recordCount` is the number of indexed emails (one per unique message id).
- `idle.enabled` stays `true` while IMAP IDLE is running; `idle.connected` turns `false` while it is waiting to reconnect — a stall detector can compare both.
