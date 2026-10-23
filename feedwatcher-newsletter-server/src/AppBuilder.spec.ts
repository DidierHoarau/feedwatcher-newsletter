import * as fs from "fs";
import * as os from "os";
import path from "path";
import { FastifyInstance } from "fastify";
import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { buildApp } from "./AppBuilder";
import { Config } from "./Config";
import { OTelSetTracer } from "./OTelContext";
import { EmailsDataInit, EmailItemsBatchSave } from "./emails/EmailsData";
import { EmailItem } from "./emails/EmailFetcher";
import { FeedIdentityGetFeedUrlId, FeedIdentityInit } from "./feeds/FeedIdentity";

const DAILY_ID = "11111111-1111-4111-8111-111111111111";
const DAILY_2_ID = "22222222-2222-4222-8222-222222222222";
const BREW_ID = "33333333-3333-4333-8333-333333333333";
const IGNORED_ID = "44444444-4444-4444-8444-444444444444";
const PIXEL_ID = "55555555-5555-4555-8555-555555555555";

let dataDir: string;
let tokensPath: string;
let app: FastifyInstance | undefined;

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

function makeConfig(overrides: Partial<Config> = {}): Config {
  return Object.assign(new Config(), {
    PUBLIC_URL: "",
    DATA_DIR: dataDir,
    ...overrides,
  });
}

function initFeedIdentity(
  options: { privateUrlsStrict?: boolean; privateUrls?: boolean } = {},
): void {
  FeedIdentityInit({
    ignoreList: "billing",
    overrides: {},
    privateUrls: options.privateUrls ?? true,
    privateUrlsStrict: options.privateUrlsStrict ?? false,
    dataDir,
  });
}

function build(config: Config): FastifyInstance {
  app = buildApp(config);
  return app;
}

function basic(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "appbuilder-"));
  tokensPath = path.join(dataDir, "feed-tokens.json");
  EmailsDataInit(7, dataDir);
  initFeedIdentity();
  EmailItemsBatchSave([
    makeItem(),
    makeItem({
      id: DAILY_2_ID,
      messageId: "<daily-2@example.com>",
      subject: "Second daily issue",
      body: "<p>Second body</p>",
      dateReceived: "2026-10-16T08:00:00.000Z",
    }),
    makeItem({
      id: BREW_ID,
      messageId: "<brew-1@example.com>",
      senderName: "Morning Brew",
      senderEmail: "brew@morningbrew.com",
      subject: "Brew issue",
      body: "<p>Brew body</p>",
    }),
    makeItem({
      id: IGNORED_ID,
      messageId: "<ignored-1@example.com>",
      senderName: "Billing Team",
      senderEmail: "billing@shop.com",
      subject: "Your invoice",
      body: "<p>Invoice</p>",
    }),
    makeItem({
      id: PIXEL_ID,
      messageId: "<pixel-1@example.com>",
      subject: "Pixel issue",
      body: '<p>Pixel body</p><img src="https://tracker.example/pixel" width="1">',
    }),
  ]);
  OTelSetTracer(new StandardTracer(new Config()));
});

beforeEach(() => {
  initFeedIdentity();
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = undefined;
  }
});

describe("feed listing routes", () => {
  it("serves the HTML index with tokenized feed URLs and without ignored senders", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/",
      headers: { accept: "text/html" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("The Daily");
    expect(response.body).toContain("/rss/thedaily.");
    expect(response.body).not.toContain("Billing Team");
  });

  it("serves the JSON feed list without ignored senders", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/",
    });
    expect(response.statusCode).toBe(200);
    const feeds = response.json() as {
      id: string;
      senderName: string;
      senderEmail: string;
      feedUrl: string;
    }[];
    expect(feeds.map((feed) => feed.id).sort()).toEqual([
      "morningbrew",
      "thedaily",
    ]);
    expect(feeds.every((feed) => feed.feedUrl.includes("/rss/"))).toBe(true);
    expect(response.body).not.toContain("billing@shop.com");
  });

  it("serves the OPML export without ignored senders", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/opml",
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/x-opml");
    expect(response.body).toContain("<outline");
    expect(response.body).toContain("/rss/thedaily.");
    expect(response.body).not.toContain("Billing Team");
  });
});

describe("feed route", () => {
  it("serves a valid tokenized feed", async () => {
    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: `/rss/${urlId}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/rss+xml");
    expect(response.body).toContain("Daily issue");
    expect(response.body).toContain(`/view/${DAILY_ID}`);
  });

  it("returns 404 for an invalid token and persists nothing", async () => {
    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    const token = urlId.slice(urlId.indexOf(".") + 1);
    const before = fs.readFileSync(tokensPath, "utf8");
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: `/rss/thedaily.${"0".repeat(token.length)}`,
    });
    expect(response.statusCode).toBe(404);
    expect(fs.readFileSync(tokensPath, "utf8")).toBe(before);
  });

  it("returns 404 for an unknown feed and creates no token", async () => {
    FeedIdentityGetFeedUrlId("thedaily");
    const before = fs.readFileSync(tokensPath, "utf8");
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/ghostfeed",
    });
    expect(response.statusCode).toBe(404);
    expect(fs.readFileSync(tokensPath, "utf8")).toBe(before);
  });

  it("does not serve an ignored sender feed", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/billingteam",
    });
    expect(response.statusCode).toBe(404);
  });

  it("accepts bare ids by default and rejects them in strict private mode", async () => {
    const defaultResponse = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/thedaily",
    });
    expect(defaultResponse.statusCode).toBe(200);

    await app?.close();
    app = undefined;
    initFeedIdentity({ privateUrlsStrict: true });
    const strictApp = build(makeConfig());
    const bareResponse = await strictApp.inject({
      method: "GET",
      url: "/rss/thedaily",
    });
    expect(bareResponse.statusCode).toBe(404);
    const tokenizedResponse = await strictApp.inject({
      method: "GET",
      url: `/rss/${FeedIdentityGetFeedUrlId("thedaily")}`,
    });
    expect(tokenizedResponse.statusCode).toBe(200);
  });
});

describe("view route", () => {
  it("serves a normal email permalink", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: `/view/${DAILY_ID}`,
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.body).toContain("Daily issue");
  });

  it("returns 404 for an unknown email id", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/view/99999999-9999-4999-8999-999999999999",
    });
    expect(response.statusCode).toBe(404);
  });

  it("returns 404 for an ignored sender email", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: `/view/${IGNORED_ID}`,
    });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain("Invoice");
  });

  it("strips tracking pixels by default and keeps them when disabled", async () => {
    const config = makeConfig();
    const stripped = await build(config).inject({
      method: "GET",
      url: `/view/${PIXEL_ID}`,
    });
    expect(stripped.statusCode).toBe(200);
    expect(stripped.body).not.toContain("tracker.example/pixel");

    config.EMAIL_STRIP_TRACKING_PIXELS = false;
    const kept = await app!.inject({ method: "GET", url: `/view/${PIXEL_ID}` });
    expect(kept.body).toContain("tracker.example/pixel");
  });
});

describe("authentication", () => {
  it("is disabled by default and leaves /api/status open", async () => {
    const fastify = build(makeConfig());
    expect((await fastify.inject({ method: "GET", url: "/rss/" })).statusCode).toBe(200);
    expect(
      (await fastify.inject({ method: "GET", url: `/view/${DAILY_ID}` }))
        .statusCode,
    ).toBe(200);
    expect(
      (await fastify.inject({ method: "GET", url: "/api/status" })).statusCode,
    ).toBe(200);
  });

  it("protects content routes and keeps /api/status open when enabled", async () => {
    const config = makeConfig({ AUTH_PASSWORD: "s3cret" });
    const fastify = build(config);
    const urlId = FeedIdentityGetFeedUrlId("thedaily");
    const paths = ["/", "/rss/", "/rss/opml", `/rss/${urlId}`, `/view/${DAILY_ID}`];

    for (const url of paths) {
      const missing = await fastify.inject({ method: "GET", url });
      expect(missing.statusCode).toBe(401);
      expect(missing.headers["www-authenticate"]).toContain("Basic");

      const wrongUser = await fastify.inject({
        method: "GET",
        url,
        headers: { authorization: basic("other", "s3cret") },
      });
      expect(wrongUser.statusCode).toBe(401);

      const wrongPassword = await fastify.inject({
        method: "GET",
        url,
        headers: { authorization: basic("feedwatcher", "wrong") },
      });
      expect(wrongPassword.statusCode).toBe(401);

      const malformed = await fastify.inject({
        method: "GET",
        url,
        headers: { authorization: "Basic not-base64-without-colon" },
      });
      expect(malformed.statusCode).toBe(401);

      const valid = await fastify.inject({
        method: "GET",
        url,
        headers: { authorization: basic("feedwatcher", "s3cret") },
      });
      expect(valid.statusCode).toBe(url === "/" ? 302 : 200);
    }

    expect(
      (await fastify.inject({ method: "GET", url: "/api/status" })).statusCode,
    ).toBe(200);
  });

  it("applies an AUTH_PASSWORD change without rebuilding the app", async () => {
    const config = makeConfig();
    const fastify = build(config);
    expect((await fastify.inject({ method: "GET", url: "/rss/" })).statusCode).toBe(200);

    config.AUTH_PASSWORD = "s3cret";

    expect((await fastify.inject({ method: "GET", url: "/rss/" })).statusCode).toBe(401);
    expect(
      (
        await fastify.inject({
          method: "GET",
          url: "/rss/",
          headers: { authorization: basic("feedwatcher", "s3cret") },
        })
      ).statusCode,
    ).toBe(200);
  });
});

describe("base URL", () => {
  it("keeps the request port when PUBLIC_URL is empty", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/",
      headers: { host: "example.com:19107" },
    });
    const feeds = response.json() as { feedUrl: string }[];
    expect(feeds[0].feedUrl).toMatch(/^http:\/\/example\.com:19107\/rss\//);
  });

  it("uses PUBLIC_URL and trims trailing slashes", async () => {
    const response = await build(
      makeConfig({ PUBLIC_URL: "https://feeds.example.com/" }),
    ).inject({ method: "GET", url: "/rss/" });
    const feeds = response.json() as { feedUrl: string }[];
    expect(feeds[0].feedUrl).toMatch(/^https:\/\/feeds\.example\.com\/rss\//);
  });

  it("honours X-Forwarded-* only when TRUST_PROXY is enabled", async () => {
    const headers = {
      "x-forwarded-proto": "https",
      "x-forwarded-host": "feeds.example.com:8443",
    };
    const trusted = await build(makeConfig({ TRUST_PROXY: true })).inject({
      method: "GET",
      url: "/rss/",
      headers,
    });
    const trustedFeeds = trusted.json() as { feedUrl: string }[];
    expect(trustedFeeds[0].feedUrl).toMatch(
      /^https:\/\/feeds\.example\.com:8443\/rss\//,
    );

    await app?.close();
    app = undefined;
    const untrusted = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/",
      headers,
    });
    const untrustedFeeds = untrusted.json() as { feedUrl: string }[];
    expect(untrustedFeeds[0].feedUrl).not.toContain("feeds.example.com");
    expect(untrustedFeeds[0].feedUrl).toMatch(/^http:\/\/localhost(:\d+)?\/rss\//);
  });
});
