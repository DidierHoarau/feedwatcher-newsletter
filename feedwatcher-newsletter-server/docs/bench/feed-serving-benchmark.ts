// Repeatable feed-serving benchmark.
//
// Run from feedwatcher-newsletter-server/:
//   npx tsx docs/bench/feed-serving-benchmark.ts
//   npx tsx docs/bench/feed-serving-benchmark.ts --records 1000 --feeds 50 \
//     --body-bytes 100000 --iterations 30 --warmup 3 --out after.json
//
// It writes a synthetic journal (default: 1,000 records / ~100 MB across 50
// senders), starts the real Fastify app against it and measures handler
// latency with app.inject (no network). The same script runs on revisions
// without the in-memory index, so the before/after numbers are comparable.
import * as fs from "fs";
import * as os from "os";
import path from "path";
import { performance } from "perf_hooks";
import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { Config } from "../../src/Config";
import { OTelSetTracer } from "../../src/OTelContext";
import { buildApp } from "../../src/AppBuilder";
import { EmailsDataInit } from "../../src/emails/EmailsData";
import { EmailItem } from "../../src/emails/EmailFetcher";
import { FeedIdentityInit } from "../../src/feeds/FeedIdentity";

interface Options {
  records: number;
  feeds: number;
  bodyBytes: number;
  iterations: number;
  warmup: number;
  out: string;
  keep: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    records: 1000,
    feeds: 50,
    bodyBytes: 100000,
    iterations: 30,
    warmup: 3,
    out: "",
    keep: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`Missing value for ${arg}`);
      return value;
    };
    switch (arg) {
      case "--records":
        options.records = Number(next());
        break;
      case "--feeds":
        options.feeds = Number(next());
        break;
      case "--body-bytes":
        options.bodyBytes = Number(next());
        break;
      case "--iterations":
        options.iterations = Number(next());
        break;
      case "--warmup":
        options.warmup = Number(next());
        break;
      case "--out":
        options.out = next();
        break;
      case "--keep":
        options.keep = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

const BODY_SENTENCE =
  "This is a synthetic newsletter body used by the feed-serving benchmark. ";

function makeBody(bodyBytes: number): string {
  const chunk = `<p>${BODY_SENTENCE.repeat(
    Math.ceil(bodyBytes / BODY_SENTENCE.length) + 1,
  ).slice(0, Math.max(0, bodyBytes - 7))}</p>`;
  return chunk;
}

function makeItem(
  index: number,
  senderIndex: number,
  body: string,
  nowMs: number,
): EmailItem {
  const date = new Date(nowMs - index * 60000).toISOString();
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    messageId: `<bench-${index}@example.com>`,
    senderName: `Sender ${senderIndex}`,
    senderEmail: `sender${senderIndex}@example.com`,
    subject: `Newsletter ${index} from sender ${senderIndex}`,
    body,
    dateReceived: date,
    dateCreated: date,
  };
}

function writeFixture(
  journalPath: string,
  records: number,
  feeds: number,
  bodyBytes: number,
): void {
  const nowMs = Date.now();
  const bodies = new Map<number, string>();
  for (let sender = 0; sender < feeds; sender++) {
    // One distinct body per sender keeps memory bounded while giving every
    // feed realistic content.
    bodies.set(sender, makeBody(bodyBytes));
  }
  const fd = fs.openSync(journalPath, "w");
  try {
    for (let index = 0; index < records; index++) {
      const sender = index % feeds;
      const item = makeItem(index, sender, bodies.get(sender) as string, nowMs);
      fs.writeSync(fd, `${JSON.stringify(item)}\n`);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function percentile(sorted: number[], ratio: number): number {
  if (sorted.length === 0) return 0;
  const position = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(ratio * sorted.length) - 1),
  );
  return sorted[position];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

interface Stats {
  cold: number;
  p50: number;
  p95: number;
  mean: number;
  max: number;
  status: number;
}

async function measure(
  app: ReturnType<typeof buildApp>,
  endpoint: { name: string; url: string; headers?: Record<string, string> },
  iterations: number,
  warmup: number,
  peak: { rss: number; heapUsed: number },
): Promise<Stats> {
  const run = async (): Promise<{ ms: number; status: number }> => {
    const start = performance.now();
    const response = await app.inject({
      method: "GET",
      url: endpoint.url,
      headers: endpoint.headers,
    });
    const ms = performance.now() - start;
    const usage = process.memoryUsage();
    peak.rss = Math.max(peak.rss, usage.rss);
    peak.heapUsed = Math.max(peak.heapUsed, usage.heapUsed);
    return { ms, status: response.statusCode };
  };

  const cold = await run();
  for (let i = 0; i < warmup; i++) await run();
  const durations: number[] = [];
  let status = cold.status;
  for (let i = 0; i < iterations; i++) {
    const result = await run();
    durations.push(result.ms);
    status = result.status;
  }
  const sorted = [...durations].sort((a, b) => a - b);
  const mean = durations.reduce((sum, value) => sum + value, 0) / durations.length;
  return {
    cold: round(cold.ms),
    p50: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    mean: round(mean),
    max: round(sorted[sorted.length - 1]),
    status,
  };
}

function formatTable(results: { name: string; stats: Stats }[]): string {
  const lines = [
    "| Endpoint | Status | Cold (ms) | p50 (ms) | p95 (ms) | Mean (ms) | Max (ms) |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const { name, stats } of results) {
    lines.push(
      `| ${name} | ${stats.status} | ${stats.cold} | ${stats.p50} | ${stats.p95} | ${stats.mean} | ${stats.max} |`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feed-serving-bench-"));
  const journalPath = path.join(dataDir, "emails.jsonl");
  let app: ReturnType<typeof buildApp> | undefined;
  try {
    console.log(
      `Generating fixture: ${options.records} records, ${options.feeds} feeds, ~${options.bodyBytes} B body`,
    );
    writeFixture(journalPath, options.records, options.feeds, options.bodyBytes);
    const journalBytes = fs.statSync(journalPath).size;

    const config = Object.assign(new Config(), {
      DATA_DIR: dataDir,
      PUBLIC_URL: "https://feeds.example.com",
    });
    OTelSetTracer(new StandardTracer(config));
    EmailsDataInit(7, dataDir);
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: false,
      dataDir,
    });
    app = buildApp(config);

    const usageAfterInit = process.memoryUsage();
    const peak = {
      rss: usageAfterInit.rss,
      heapUsed: usageAfterInit.heapUsed,
    };

    const largestFeedId = "sender0";
    const itemId = "00000000-0000-4000-8000-000000000000";
    const feedUrl = `/rss/${largestFeedId}`;

    // Fetch one feed first so the conditional request has a validator.
    const prime = await app.inject({ method: "GET", url: feedUrl });
    const etag = prime.headers.etag;
    const lastModified = prime.headers["last-modified"];

    const endpoints = [
      { name: "GET /rss/ (JSON)", url: "/rss/" },
      {
        name: "GET /rss/ (HTML)",
        url: "/rss/",
        headers: { accept: "text/html" },
      },
      { name: "GET /rss/opml", url: "/rss/opml" },
      { name: `GET /rss/${largestFeedId}`, url: feedUrl },
      { name: `GET /view/<item>`, url: `/view/${itemId}` },
      {
        name: `GET /rss/${largestFeedId} (If-None-Match)`,
        url: feedUrl,
        headers: { "if-none-match": etag || '"benchmark-no-etag"' },
      },
    ];

    const results: { name: string; stats: Stats }[] = [];
    for (const endpoint of endpoints) {
      results.push({
        name: endpoint.name,
        stats: await measure(
          app,
          endpoint,
          options.iterations,
          options.warmup,
          peak,
        ),
      });
    }

    const summary = {
      generatedAt: new Date().toISOString(),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      cpu: os.cpus()[0]?.model || "unknown",
      records: options.records,
      feeds: options.feeds,
      bodyBytes: options.bodyBytes,
      iterations: options.iterations,
      warmup: options.warmup,
      journalBytes,
      journalMB: round(journalBytes / (1024 * 1024)),
      etag: etag || null,
      lastModified: lastModified || null,
      memoryAfterInitMB: {
        rss: round(usageAfterInit.rss / (1024 * 1024)),
        heapUsed: round(usageAfterInit.heapUsed / (1024 * 1024)),
      },
      peakMemoryMB: {
        rss: round(peak.rss / (1024 * 1024)),
        heapUsed: round(peak.heapUsed / (1024 * 1024)),
      },
      results,
    };

    console.log("");
    console.log(formatTable(results));
    console.log("");
    console.log(
      `Journal ${summary.journalMB} MB; RSS after init ${summary.memoryAfterInitMB.rss} MB, peak ${summary.peakMemoryMB.rss} MB (heap peak ${summary.peakMemoryMB.heapUsed} MB)`,
    );
    console.log(
      `ETag: ${summary.etag ?? "none"}; Last-Modified: ${summary.lastModified ?? "none"}`,
    );
    console.log("");
    console.log(JSON.stringify(summary, null, 2));

    if (options.out) {
      fs.writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
      console.log(`\nWrote ${options.out}`);
    }
  } finally {
    if (app) await app.close();
    if (options.keep) {
      console.log(`Fixture kept in ${dataDir}`);
    } else {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
