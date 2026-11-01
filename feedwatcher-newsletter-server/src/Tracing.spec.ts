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
  attributes: Record<string, unknown>;
  end: jest.Mock;
}

let dataDir: string;
let app: FastifyInstance | undefined;
let spans: RecordedSpan[];

const startSpanMock = jest.fn(
  (name: string, parent?: unknown, options?: { kind?: SpanKind }) => {
    const span: RecordedSpan = {
      name,
      parent,
      options,
      attributes: {},
      end: jest.fn(),
      setAttribute: jest.fn((key: string, value: unknown) => {
        span.attributes[key] = value;
        return span;
      }),
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

function attributeValues(span: RecordedSpan): string[] {
  return Object.values(span.attributes).map((value) => String(value));
}

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
    const cases: Array<[string, string, number, string]> = [
      [`/view/${DAILY_ID}`, "GET-/view/_emailId", 200, "/view/:emailId"],
      ["/rss/opml", "GET-/rss/opml", 200, "/rss/opml"],
      ["/rss/", "GET-/rss", 200, "/rss"],
      ["/", "GET-/", 302, "/"],
      ["/api/feeds", "GET-/api/feeds", 200, "/api/feeds"],
    ];
    for (const [url, spanName, statusCode, urlPath] of cases) {
      spans = [];
      startSpanMock.mockClear();
      const response = await fastify.inject({ method: "GET", url });
      expect(response.statusCode).toBe(statusCode);
      expect(spans.map((span) => span.name)).toEqual([spanName]);
      expect(spans[0].options).toEqual({ kind: SpanKind.SERVER });
      expect(spans[0].attributes["url.path"]).toBe(urlPath);
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
    expect(spans[0].attributes["url.path"]).toBe("/does-not-exist");
  });
});

describe("span url.path redaction", () => {
  const TOKEN = "0123456789abcdef01234567";

  it("records the route template instead of a tokenized feed path", async () => {
    const response = await build().inject({
      method: "GET",
      url: `/rss/thedaily.${TOKEN}`,
    });

    expect(response.statusCode).toBe(200);
    expect(spans[0].name).toBe("GET-/rss/_id");
    expect(spans[0].attributes["url.path"]).toBe("/rss/:id");
    expect(spans[0].attributes["http.route"]).toBe("/rss/:id");
    expect(
      attributeValues(spans[0]).some((value) => value.includes(TOKEN)),
    ).toBe(false);
  });

  it("redacts a token-like segment on unmatched paths", async () => {
    const response = await build().inject({
      method: "GET",
      url: `/rss/thedaily.${TOKEN}/extra`,
    });

    expect(response.statusCode).toBe(404);
    expect(spans[0].name).toBe("GET");
    expect(spans[0].attributes["url.path"]).toBe("/rss/:redacted/extra");
    expect(
      attributeValues(spans[0]).some((value) => value.includes(TOKEN)),
    ).toBe(false);
  });

  it("redacts the token even when access control rejects the request", async () => {
    const config = Object.assign(new Config(), {
      PUBLIC_URL: "",
      DATA_DIR: dataDir,
      AUTH_PASSWORD: "s3cret",
    });
    app = buildApp(config);
    const response = await app.inject({
      method: "GET",
      url: `/rss/thedaily.${TOKEN}`,
    });

    expect(response.statusCode).toBe(401);
    expect(spans[0].attributes["url.path"]).toBe("/rss/:id");
    expect(
      attributeValues(spans[0]).some((value) => value.includes(TOKEN)),
    ).toBe(false);
  });
});
