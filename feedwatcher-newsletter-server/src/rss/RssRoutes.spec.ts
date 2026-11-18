import * as fs from "fs";
import * as os from "os";
import path from "path";
import Fastify, { FastifyInstance } from "fastify";
import { Config } from "../Config";
import {
  EmailsDataInit,
  EmailFeedsListAll,
  EmailItemsBatchSave,
} from "../emails/EmailsData";
import { EmailItem } from "../emails/EmailFetcher";
import {
  FeedIdentityEnsureTokens,
  FeedIdentityGetFeedUrlId,
  FeedIdentityInit,
} from "../feeds/FeedIdentity";
import { FeedSettingsSave } from "../feeds/FeedSettings";
import * as OTelContextMock from "../OTelContext";
import { RssRoutes } from "./RssRoutes";

// The route logger is a module-level constant, so OTelContext must be mocked
// before RssRoutes is imported (jest hoists this call).
jest.mock("../OTelContext", () => {
  const logger = {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    OTelRequestSpan: () => ({}),
    OTelRunWithRequestContext: (
      _request: unknown,
      handler: () => unknown,
    ) => handler(),
    OTelTracer: () => ({ startSpan: () => ({ end: jest.fn() }) }),
    __mockLogger: logger,
  };
});

interface LoggerMock {
  debug: jest.Mock;
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
}

const mockLogger = (
  OTelContextMock as unknown as { __mockLogger: LoggerMock }
).__mockLogger;

function loggedText(): string {
  return [
    ...mockLogger.debug.mock.calls,
    ...mockLogger.info.mock.calls,
    ...mockLogger.warn.mock.calls,
    ...mockLogger.error.mock.calls,
  ]
    .flat()
    .map((arg) => String(arg))
    .join("\n");
}

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
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

let dataDir: string;
let fastify: FastifyInstance;
let config: Config;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rssroutes-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: true,
    dataDir,
  });
  EmailItemsBatchSave([makeItem()]);
  config = Object.assign(new Config(), {
    PUBLIC_URL: "",
    DATA_DIR: dataDir,
  });
  fastify = Fastify();
  fastify.register(new RssRoutes(config).getRoutes, { prefix: "/rss" });
  // Seeding emits info logs of its own; only request logs are under test.
  jest.clearAllMocks();
});

afterEach(async () => {
  await fastify.close();
});

describe("feed token redaction in logs", () => {
  it("logs only the feed id when a feed token is invalid", async () => {
    const wrongToken = "0".repeat(24);
    const response = await fastify.inject({
      method: "GET",
      url: `/rss/thedaily.${wrongToken}`,
    });
    expect(response.statusCode).toBe(404);

    expect(loggedText()).toContain("thedaily");
    expect(loggedText()).not.toContain(wrongToken);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "Invalid feed token for feed: thedaily",
      expect.anything(),
    );
  });

  it("never logs the token of a valid tokenized feed request", async () => {
    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    const token = urlId.slice(urlId.indexOf(".") + 1);
    expect(token.length).toBeGreaterThan(0);
    jest.clearAllMocks();

    const response = await fastify.inject({
      method: "GET",
      url: `/rss/${urlId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/rss+xml");
    expect(loggedText()).not.toContain(token);
  });
});

describe("feed ids without Latin characters", () => {
  it("serves a tokenized feed for a non-Latin sender and 404s unknown fallback ids", async () => {
    EmailItemsBatchSave([
      makeItem({
        id: "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        messageId: "<cn-news@example.com>",
        senderName: "中文日报",
        senderEmail: "cn@example.com",
        subject: "今日要闻",
      }),
    ]);
    const feed = EmailFeedsListAll().find(
      (entry) => entry.senderName === "中文日报",
    );
    expect(feed?.feedId).toMatch(/^sender-[0-9a-f]{8}$/);
    FeedIdentityEnsureTokens([feed!.feedId]);
    const urlId = FeedIdentityGetFeedUrlId(feed!.feedId);
    expect(urlId.startsWith(".")).toBe(false);

    const response = await fastify.inject({
      method: "GET",
      url: `/rss/${urlId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/rss+xml");

    const unknown = await fastify.inject({
      method: "GET",
      url: "/rss/sender-deadbeef",
    });
    expect(unknown.statusCode).toBe(404);
  });

  it("does not write feed-tokens.json while serving listings", async () => {
    FeedIdentityEnsureTokens(["thedaily"]);
    const tokensPath = path.join(dataDir, "feed-tokens.json");
    const before = fs.readFileSync(tokensPath, "utf8");
    const mtime = fs.statSync(tokensPath).mtimeMs;

    const listResponse = await fastify.inject({ method: "GET", url: "/rss/" });
    const opmlResponse = await fastify.inject({
      method: "GET",
      url: "/rss/opml",
    });
    expect(listResponse.statusCode).toBe(200);
    expect(opmlResponse.statusCode).toBe(200);

    expect(fs.readFileSync(tokensPath, "utf8")).toBe(before);
    expect(fs.statSync(tokensPath).mtimeMs).toBe(mtime);
  });
});

describe("feed archive", () => {
  it("serves a tokenized archive with subject, summary, date and view link", async () => {
    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    const response = await fastify.inject({
      method: "GET",
      url: `/rss/${urlId}/archive`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Daily issue");
    expect(response.body).toContain("Daily issue body");
    expect(response.body).toContain("Thu, 15 Oct 2026 08:00:00 GMT");
    expect(response.body).toContain(
      "/view/11111111-1111-4111-8111-111111111111",
    );
    expect(response.body).not.toContain("<script");
    expect(response.body).toContain("1 retained email(s)");
  });

  it("accepts bare ids by default and rejects them in strict private mode", async () => {
    const bare = await fastify.inject({ method: "GET", url: "/rss/thedaily/archive" });
    expect(bare.statusCode).toBe(200);

    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: true,
      privateUrlsStrict: true,
      dataDir,
    });
    const strictBare = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily/archive",
    });
    expect(strictBare.statusCode).toBe(404);
    const strictTokenized = await fastify.inject({
      method: "GET",
      url: `/rss/${urlId}/archive`,
    });
    expect(strictTokenized.statusCode).toBe(200);
  });

  it("returns 404 for an invalid token without logging it", async () => {
    const wrongToken = "0".repeat(24);
    const response = await fastify.inject({
      method: "GET",
      url: `/rss/thedaily.${wrongToken}/archive`,
    });
    expect(response.statusCode).toBe(404);
    expect(loggedText()).toContain("thedaily");
    expect(loggedText()).not.toContain(wrongToken);
  });

  it("returns 404 for an unknown feed", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/rss/ghostfeed/archive",
    });
    expect(response.statusCode).toBe(404);
  });

  it("answers conditional requests and changes the ETag after an append", async () => {
    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    const url = `/rss/${urlId}/archive`;
    const first = await fastify.inject({ method: "GET", url });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toMatch(/^".+"$/);
    expect(first.headers["last-modified"]).toBeTruthy();
    expect(first.headers["cache-control"]).toBe("private, no-cache");

    const notModified = await fastify.inject({
      method: "GET",
      url,
      headers: { "if-none-match": first.headers.etag as string },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");

    EmailItemsBatchSave([
      makeItem({
        id: "99999999-9999-4999-8999-999999999999",
        messageId: "<daily-archive-new@example.com>",
        subject: "Fresh archive issue",
        body: "<p>Fresh archive body</p>",
        dateReceived: new Date().toISOString(),
        dateCreated: new Date().toISOString(),
      }),
    ]);
    const changed = await fastify.inject({
      method: "GET",
      url,
      headers: { "if-none-match": first.headers.etag as string },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(first.headers.etag);
    expect(changed.body).toContain("Fresh archive issue");
  });

  it("lists every retained email while the feed is capped", async () => {
    EmailItemsBatchSave([
      makeItem({
        id: "22222222-2222-4222-8222-222222222222",
        messageId: "<daily-2@example.com>",
        subject: "Second daily issue",
        body: "<p>Second body</p>",
        dateReceived: "2026-10-16T08:00:00.000Z",
        dateCreated: "2026-10-16T08:00:00.000Z",
      }),
      makeItem({
        id: "33333333-3333-4333-8333-333333333333",
        messageId: "<daily-3@example.com>",
        subject: "Third daily issue",
        body: "<p>Third body</p>",
        dateReceived: "2026-10-17T08:00:00.000Z",
        dateCreated: "2026-10-17T08:00:00.000Z",
      }),
    ]);
    config.FEED_MAX_ITEMS = 1;

    const feed = await fastify.inject({ method: "GET", url: "/rss/thedaily" });
    expect(feed.statusCode).toBe(200);
    expect((feed.body.match(/<item>/g) || [])).toHaveLength(1);
    expect(feed.body).toContain("Third daily issue");
    expect(feed.body).not.toContain("Second daily issue");

    const archive = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily/archive",
    });
    expect(archive.statusCode).toBe(200);
    for (const subject of [
      "Daily issue",
      "Second daily issue",
      "Third daily issue",
    ]) {
      expect(archive.body).toContain(subject);
    }
    expect(archive.body).toContain(
      "3 retained email(s). The RSS feed serves the newest 1.",
    );
  });
});

describe("feed settings: hidden and merged feeds", () => {
  function seedBrew(): void {
    EmailItemsBatchSave([
      makeItem({
        id: "22222222-2222-4222-8222-222222222222",
        messageId: "<brew-1@example.com>",
        senderName: "Morning Brew",
        senderEmail: "brew@morningbrew.com",
        subject: "Brew issue",
      }),
    ]);
    FeedIdentityEnsureTokens(["thedaily", "morningbrew"]);
  }

  it("returns 404 for a hidden feed and its archive, then restores it", async () => {
    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    FeedSettingsSave({ version: 1, feeds: { thedaily: { hidden: true } } });

    const feed = await fastify.inject({ method: "GET", url: `/rss/${urlId}` });
    expect(feed.statusCode).toBe(404);
    const archive = await fastify.inject({
      method: "GET",
      url: `/rss/${urlId}/archive`,
    });
    expect(archive.statusCode).toBe(404);

    FeedSettingsSave({ version: 1, feeds: {} });
    const restored = await fastify.inject({
      method: "GET",
      url: `/rss/${urlId}`,
    });
    expect(restored.statusCode).toBe(200);
  });

  it("redirects a merged source to the target feed and archive", async () => {
    seedBrew();
    FeedSettingsSave({
      version: 1,
      feeds: { morningbrew: { mergeInto: "thedaily" } },
    });
    const sourceUrlId = FeedIdentityGetFeedUrlId("morningbrew");
    const targetUrlId = FeedIdentityGetFeedUrlId("thedaily");

    const feed = await fastify.inject({
      method: "GET",
      url: `/rss/${sourceUrlId}`,
    });
    expect(feed.statusCode).toBe(302);
    expect(feed.headers.location).toBe(`/rss/${targetUrlId}`);

    const followed = await fastify.inject({
      method: "GET",
      url: String(feed.headers.location),
    });
    expect(followed.statusCode).toBe(200);
    expect(followed.body).toContain("Daily issue");
    expect(followed.body).toContain("Brew issue");

    const archive = await fastify.inject({
      method: "GET",
      url: `/rss/${sourceUrlId}/archive`,
    });
    expect(archive.statusCode).toBe(302);
    expect(archive.headers.location).toBe(`/rss/${targetUrlId}/archive`);
  });

  it("returns 404 for a source whose final merge target is hidden", async () => {
    seedBrew();
    FeedSettingsSave({
      version: 1,
      feeds: {
        morningbrew: { mergeInto: "thedaily" },
        thedaily: { hidden: true },
      },
    });
    const response = await fastify.inject({
      method: "GET",
      url: `/rss/${FeedIdentityGetFeedUrlId("morningbrew")}`,
    });
    expect(response.statusCode).toBe(404);
  });

  it("serves per-feed privacy and item settings", async () => {
    const pixel = makeItem({
      id: "33333333-3333-4333-8333-333333333333",
      messageId: "<pixel@example.com>",
      subject: "Pixel issue",
      body: '<p>Pixel</p><img src="https://tracker.example/p.gif" width="1">',
    });
    EmailItemsBatchSave([pixel]);
    config.EMAIL_STRIP_TRACKING_PIXELS = false;
    FeedSettingsSave({
      version: 1,
      feeds: { thedaily: { stripTrackingPixels: true, maxItems: 0 } },
    });

    const response = await fastify.inject({
      method: "GET",
      url: `/rss/${FeedIdentityGetFeedUrlId("thedaily")}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).not.toContain("tracker.example");
  });
});
