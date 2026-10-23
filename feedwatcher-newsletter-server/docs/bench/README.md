# Feed-serving benchmark

Repeatable before/after measurement for the "make feed serving cheap" change
(code review finding M1 plus HTTP caching/compression). The benchmark drives
the real Fastify app with `app.inject` (handler latency, no network) against a
synthetic journal, so the same script runs on revisions without the in-memory
index and the numbers stay comparable.

## Method

```bash
cd feedwatcher-newsletter-server
npx tsx docs/bench/feed-serving-benchmark.ts --out after.json
```

Options (defaults in brackets): `--records [1000]`, `--feeds [50]`,
`--body-bytes [100000]`, `--iterations [30]`, `--warmup [3]`,
`--out <file>`, `--keep` (keep the temporary fixture).

The fixture is written directly as `emails.jsonl` (so the script works on both
revisions): one record per email, 50 senders × 20 emails, one ~100 KB HTML body
per sender, dates within the retention window. `EmailsDataInit` is called once
(after the change this builds the index), `FeedIdentityInit` runs with
`privateUrls: false`, and the app is built against the fixture directory.

Endpoints measured: `/rss/` JSON, `/rss/` HTML, `/rss/opml`, the largest feed
(`/rss/sender0`), one `/view/<itemId>` page, and one conditional
`If-None-Match` request for `/rss/sender0` (the ETag of a priming request is
reused). Each endpoint gets one cold request, `--warmup` warmups and
`--iterations` measured requests; the report lists cold, p50, p95, mean and max
in milliseconds. `process.memoryUsage()` is sampled after init and on every
request; the peak RSS/heap is reported.

## Environment

- Node.js `v26.12.0`, Linux x64, CPU `Intel(R) N100`
- Journal: 1,000 records, 95.63 MB; 50 feeds; iteration count 30, warmup 3

## Revisions

- **Before**: `dd42808` (main, without this change) — run 2026-10-23.
- **After**: `89316bf` (this change) — same machine, same fixture settings.

## Results

Latency in ms.

### Before (`dd42808`)

| Endpoint | Cold | p50 | p95 | Mean | Max |
| --- | --- | --- | --- | --- | --- |
| GET /rss/ (JSON) | 203.81 | 151.76 | 179.41 | 156.15 | 199.09 |
| GET /rss/ (HTML) | 169.47 | 186.84 | 261.73 | 197.88 | 272.01 |
| GET /rss/opml | 204.11 | 167.61 | 283.81 | 182.67 | 313.98 |
| GET /rss/sender0 | 244.92 | 271.49 | 644.71 | 319.04 | 733.87 |
| GET /view/&lt;item&gt; | 174.29 | 174.07 | 230.93 | 181.77 | 248.94 |
| GET /rss/sender0 (If-None-Match) | 277.26 | 340.79 | 374.55 | 338.41 | 404.06 |

Status: all 200 (the revision has no ETag, so the conditional request is a
normal 200 and never short-circuits).

### After (`89316bf`)

| Endpoint | Cold | p50 | p95 | Mean | Max | p95 change |
| --- | --- | --- | --- | --- | --- | --- |
| GET /rss/ (JSON) | 2.75 | 1.18 | 2.12 | 1.55 | 11.10 | −98.8% |
| GET /rss/ (HTML) | 1.57 | 1.16 | 1.65 | 1.27 | 4.23 | −99.4% |
| GET /rss/opml | 1.99 | 0.83 | 1.15 | 0.84 | 1.23 | −99.6% |
| GET /rss/sender0 | 20.89 | 26.32 | 66.59 | 30.34 | 80.21 | −89.7% |
| GET /view/&lt;item&gt; | 1.60 | 0.99 | 1.72 | 0.97 | 1.87 | −99.3% |
| GET /rss/sender0 (If-None-Match) | 17.59 | 12.75 | 21.40 | 14.15 | 22.58 | 304 |

For reference, the review baseline was 93 ms average / 333 ms p95 for
`RssFeedGeneratorBuildFeedById` over 6,097 traced builds in 7 days, and
124–186 ms per 108 MB journal scan. `/rss/sender0` still has to serialize
20 × 100 KB bodies (~2 MB of XML) plus hash it for the ETag, so its cost now
tracks the requested feed size (p95 66.59 ms in this deliberately large-body
fixture) instead of the 95.63 MB journal. The other endpoints dropped to
~1–2 ms because the index and the sanitized-body cache remove all journal I/O
and sanitization from the request path. A conditional request returns 304 but
still builds the document to compute its ETag; the win there is bandwidth.

## Memory

| | RSS after init | Peak RSS | Peak heap |
| --- | --- | --- | --- |
| Before (`dd42808`) | 147.52 MB | 480.15 MB | 100.82 MB |
| After (`89316bf`) | 341.02 MB | 538.98 MB | 226.12 MB |

The before revision re-parses the whole 95.63 MB journal on every request,
which is why its peak RSS is also high. The after revision keeps one parsed
copy (~96 MB of body strings) plus the 32 MiB sanitized cache (accounted at
raw UTF-16 size, so up to ~64 MB of heap) — 539 MB peak with a 1 GiB container
limit leaves roughly 480 MB of headroom. Retention bounds the journal, so the
index does not grow without limit.
