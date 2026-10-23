import { SpanKind } from "@opentelemetry/api";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import { FastifyInstance } from "fastify";
import { buildApp } from "./AppBuilder";
import { Config } from "./Config";
import { OTelSetTracer } from "./OTelContext";
import { EmailsDataInit, EmailItemsBatchSave } from "./emails/EmailsData";
import { EmailItem } from "./emails/EmailFetcher";
import { FeedIdentityInit } from "./feeds/FeedIdentity";

const DAILY_ID = "11111111-1111-4111-8111-111111111111";

interface RecordedSpan {
  name: string;
  parent?: unknown;
  options?: { kind?: SpanKind };
  end: jest.Mock;
}

let dataDir: string;
let app: FastifyInstance | undefined;
let spans: RecordedSpan[];

const startSpanMock = jest.fn(
  (name: string, parent?: unknown, options?: { kind?: SpanKind }) => {
    const span = {
      name,
      parent,
      options,
      end: jest.fn(),
      setAttribute: jest.fn(),
      setStatus: jest.fn(),
      recordException: jest.fn(),
      spanContext: () => ({
        traceId: "0".repeat(32),
        spanId: "0".repeat(16),
        traceFlags: 1,
      }),
    };
    spans.push(span);
    return span;
  },
);

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  return {
    id: DAILY_ID,
    messageId: "<daily-1@example.com>",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    subject: "Daily issue",
    body: "<p>Daily issue body</p>",
    dateReceived: "2026-10-15T08:00:00.000Z",
    dateCreated: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

function build(): FastifyInstance {
  const config = Object.assign(new Config(), {
    PUBLIC_URL: "",
    DATA_DIR: dataDir,
  });
  app = buildApp(config);
  return app;
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "tracing-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
  EmailItemsBatchSave([makeItem()]);
});

beforeEach(() => {
  spans = [];
  startSpanMock.mockClear();
  OTelSetTracer({ startSpan: startSpanMock } as never);
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("HTTP span tracing", () => {
  it("traces a feed request and parents the feed build under the server span", async () => {
    const response = await build().inject({ method: "GET", url: "/rss/thedaily" });

    expect(response.statusCode).toBe(200);
    expect(spans.map((span) => span.name)).toEqual([
      "GET-/rss/_id",
      "RssFeedGeneratorBuildFeedById",
    ]);
    expect(spans[0].parent).toBeUndefined();
    expect(spans[0].options).toEqual({ kind: SpanKind.SERVER });
    expect(spans[1].parent).toBe(spans[0]);
    expect(spans.every((span) => span.end.mock.calls.length === 1)).toBe(true);
  });

  it("traces the view, OPML, feed list and index routes", async () => {
    const fastify = build();
    const cases: Array<[string, string, number]> = [
      [`/view/${DAILY_ID}`, "GET-/view/_emailId", 200],
      ["/rss/opml", "GET-/rss/opml", 200],
      ["/rss/", "GET-/rss", 200],
      ["/", "GET-/", 302],
    ];
    for (const [url, spanName, statusCode] of cases) {
      spans = [];
      startSpanMock.mockClear();
      const response = await fastify.inject({ method: "GET", url });
      expect(response.statusCode).toBe(statusCode);
      expect(spans.map((span) => span.name)).toEqual([spanName]);
      expect(spans[0].options).toEqual({ kind: SpanKind.SERVER });
      expect(spans[0].end).toHaveBeenCalledTimes(1);
    }
  });

  it("does not trace the readiness endpoint", async () => {
    const response = await build().inject({ method: "GET", url: "/api/status" });

    expect(response.statusCode).toBe(200);
    expect(startSpanMock).not.toHaveBeenCalled();
  });

  it("names unmatched routes by method to keep cardinality bounded", async () => {
    const response = await build().inject({
      method: "GET",
      url: "/does-not-exist",
    });

    expect(response.statusCode).toBe(404);
    expect(spans.map((span) => span.name)).toEqual(["GET"]);
    expect(spans[0].parent).toBeUndefined();
    expect(spans[0].end).toHaveBeenCalledTimes(1);
  });
});
