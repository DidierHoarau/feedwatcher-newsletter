import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import Fastify, { FastifyInstance } from "fastify";
import { Config } from "../Config";
import { EmailsDataInit, EmailItemsBatchSave } from "../emails/EmailsData";
import { EmailItem } from "../emails/EmailFetcher";
import { FeedIdentityInit } from "../feeds/FeedIdentity";
import { FeedSettingsRoutes } from "./FeedSettingsRoutes";

jest.mock("../OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    OTelRunWithRequestContext: (
      _request: unknown,
      handler: () => unknown,
    ) => handler(),
    __mockLogger: logger,
  };
});
jest.mock("../Scheduler", () => ({
  SchedulerOnFeedSettingsChanged: jest.fn(),
}));

const schedulerMock = jest.requireMock("../Scheduler")
  .SchedulerOnFeedSettingsChanged as jest.Mock;

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

function settingsPath(): string {
  return path.join(dataDir, "feed-settings.json");
}

function csrfTokenFrom(html: unknown): string {
  const match = /name="csrf" value="([^"]+)"/.exec(String(html));
  if (!match) {
    throw new Error("CSRF input not found");
  }
  return match[1];
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

beforeEach(async () => {
  jest.clearAllMocks();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedsettingsroutes-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
  EmailItemsBatchSave([makeItem()]);
  config = Object.assign(new Config(), { DATA_DIR: dataDir });
  fastify = Fastify();
  await fastify.register(new FeedSettingsRoutes(config).getRoutes);
  await fastify.ready();
});

afterEach(async () => {
  await fastify.close();
});

describe("GET /api/feeds/settings", () => {
  it("returns the empty document with no-store caching", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/api/feeds/settings",
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual(
      JSON.stringify({ version: 1, feeds: {}, senders: {} }),
    );
    expect(response.headers["cache-control"]).toBe("no-store");
  });
});

describe("PUT /api/feeds/settings", () => {
  const document = {
    version: 1,
    feeds: { thedaily: { title: "Daily Brief", hidden: true } },
    senders: { "news@example.com": { feedId: "daily-news" } },
  };

  it("persists and applies a valid document", async () => {
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/feeds/settings",
      headers: {
        "content-type": "application/json",
        "x-feedwatcher-csrf": "1",
      },
      payload: JSON.stringify(document),
    });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toEqual(document);
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual(document);
    expect(schedulerMock).toHaveBeenCalledTimes(1);
  });

  it("requires the custom CSRF header", async () => {
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/feeds/settings",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify(document),
    });
    expect(response.statusCode).toBe(403);
    expect(schedulerMock).not.toHaveBeenCalled();
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it("requires a JSON content type", async () => {
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/feeds/settings",
      headers: {
        "content-type": "text/plain",
        "x-feedwatcher-csrf": "1",
      },
      payload: JSON.stringify(document),
    });
    expect(response.statusCode).toBe(415);
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it("rejects an invalid document with field paths and changes nothing", async () => {
    const response = await fastify.inject({
      method: "PUT",
      url: "/api/feeds/settings",
      headers: {
        "content-type": "application/json",
        "x-feedwatcher-csrf": "1",
      },
      payload: JSON.stringify({
        version: 1,
        feeds: { "Bad.Id": {} },
      }),
    });
    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.body);
    expect(body.error).toBe("Invalid feed settings");
    expect(body.details).toEqual(
      expect.arrayContaining([expect.stringContaining("invalid feed id")]),
    );
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(schedulerMock).not.toHaveBeenCalled();
  });
});

describe("GET /manage", () => {
  it("renders the current feeds, sender rows and a CSRF token", async () => {
    const response = await fastify.inject({ method: "GET", url: "/manage" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain("thedaily");
    expect(response.body).toContain("news@example.com");
    expect(response.body).toContain('name="csrf"');
    expect(response.body).toContain('action="/manage"');
    expect(csrfTokenFrom(response.body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("shows the save notice when redirected back after a save", async () => {
    const response = await fastify.inject({
      method: "GET",
      url: "/manage?saved=1",
    });
    expect(response.body).toContain("Feed settings saved and applied");
  });
});

describe("POST /manage", () => {
  async function csrf(): Promise<string> {
    const page = await fastify.inject({ method: "GET", url: "/manage" });
    return csrfTokenFrom(page.body);
  }

  it("saves the form and redirects", async () => {
    const token = await csrf();
    const response = await fastify.inject({
      method: "POST",
      url: "/manage",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody({
        csrf: token,
        "feed.thedaily.title": "My Daily",
        "feed.thedaily.hidden": "true",
        "feed.thedaily.maxItems": "0",
        "feed.thedaily.blockRemoteImages": "false",
        "feed.thedaily.stripTrackingPixels": "",
        "feed.thedaily.mergeInto": "",
        "sender.0.match": "news@example.com",
        "sender.0.feedId": "daily-news",
        "sender.0.title": "Daily News",
        "sender.1.match": "",
        "sender.1.feedId": "",
        "sender.1.title": "",
      }),
    });
    expect(response.statusCode).toBe(303);
    expect(response.headers.location).toBe("/manage?saved=1");
    expect(JSON.parse(fs.readFileSync(settingsPath(), "utf8"))).toEqual({
      version: 1,
      feeds: {
        thedaily: {
          title: "My Daily",
          hidden: true,
          maxItems: 0,
          blockRemoteImages: false,
        },
      },
      senders: {
        "news@example.com": { feedId: "daily-news", title: "Daily News" },
      },
    });
    expect(schedulerMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a missing or wrong form token", async () => {
    const response = await fastify.inject({
      method: "POST",
      url: "/manage",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody({ csrf: "0".repeat(64) }),
    });
    expect(response.statusCode).toBe(403);
    expect(fs.existsSync(settingsPath())).toBe(false);
    expect(schedulerMock).not.toHaveBeenCalled();
  });

  it("re-renders with an escaped error for invalid values", async () => {
    const token = await csrf();
    const response = await fastify.inject({
      method: "POST",
      url: "/manage",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody({
        csrf: token,
        "feed.thedaily.maxItems": "-4",
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('role="alert"');
    expect(response.body).toContain("non-negative integer");
    expect(response.body).not.toContain("<script>");
    expect(fs.existsSync(settingsPath())).toBe(false);
  });

  it("rejects a sender rule without a match", async () => {
    const token = await csrf();
    const response = await fastify.inject({
      method: "POST",
      url: "/manage",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: formBody({
        csrf: token,
        "sender.0.match": "",
        "sender.0.feedId": "daily-news",
      }),
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain("sender match is required");
    expect(fs.existsSync(settingsPath())).toBe(false);
  });
});
