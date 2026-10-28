import * as fs from "fs";
import * as os from "os";
import path from "path";
import Fastify, { FastifyInstance } from "fastify";
import { Config } from "../Config";
import { EmailsDataInit, EmailItemsBatchSave } from "../emails/EmailsData";
import { EmailItem } from "../emails/EmailFetcher";
import { FeedIdentityGetFeedUrlId, FeedIdentityInit } from "../feeds/FeedIdentity";
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
  const config = Object.assign(new Config(), {
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
