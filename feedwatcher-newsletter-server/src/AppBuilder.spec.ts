import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import path from "path";
import * as zlib from "zlib";
import { FastifyInstance } from "fastify";
import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { buildApp } from "./AppBuilder";
import { Config } from "./Config";
import { OTelSetTracer } from "./OTelContext";
import {
  EmailsDataInit,
  EmailItemsBatchSave,
  EmailsDataPurgeExpired,
} from "./emails/EmailsData";
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

// Each block below needs its own store: it appends or purges items, which
// would leak into the shared fixture used by the tests above.
describe("conditional GET", () => {
  let isolatedDir: string;

  beforeEach(() => {
    isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "appbuilder-http-"));
    EmailsDataInit(7, isolatedDir);
    FeedIdentityInit({
      ignoreList: "billing",
      overrides: {},
      privateUrls: false,
      dataDir: isolatedDir,
    });
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
    ]);
  });

  afterEach(() => {
    // Restore the shared store for any later block.
    EmailsDataInit(7, dataDir);
    initFeedIdentity();
  });

  function configForIsolated(): Config {
    return makeConfig({ DATA_DIR: isolatedDir });
  }

  it("serves ETag and Last-Modified and answers 304 for both validators", async () => {
    const fastify = build(configForIsolated());
    const first = await fastify.inject({ method: "GET", url: "/rss/thedaily" });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    const lastModified = first.headers["last-modified"] as string;
    expect(etag).toMatch(/^".+"$/);
    expect(lastModified).toBeTruthy();
    expect(first.headers["cache-control"]).toContain("no-cache");

    const byEtag = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily",
      headers: { "if-none-match": etag },
    });
    expect(byEtag.statusCode).toBe(304);
    expect(byEtag.body).toBe("");
    expect(byEtag.headers.etag).toBe(etag);

    const byDate = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily",
      headers: { "if-modified-since": lastModified },
    });
    expect(byDate.statusCode).toBe(304);
    expect(byDate.body).toBe("");
  });

  it("changes the feed ETag when an email is appended", async () => {
    const fastify = build(configForIsolated());
    const first = await fastify.inject({ method: "GET", url: "/rss/thedaily" });
    const etag = first.headers.etag as string;

    EmailItemsBatchSave([
      makeItem({
        id: "99999999-9999-4999-8999-999999999999",
        messageId: "<daily-new@example.com>",
        subject: "Fresh daily issue",
        body: "<p>Fresh body</p>",
        dateReceived: new Date().toISOString(),
      }),
    ]);

    const changed = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily",
      headers: { "if-none-match": etag },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.headers.etag).not.toBe(etag);
    expect(changed.body).toContain("Fresh daily issue");
  });

  it("drops a purged feed from the list and changes its ETag", async () => {
    const fastify = build(configForIsolated());
    EmailItemsBatchSave([
      makeItem({
        id: "88888888-8888-4888-8888-888888888888",
        messageId: "<old@example.com>",
        senderName: "Old Sender",
        senderEmail: "old@example.com",
        dateReceived: "2020-01-01T00:00:00.000Z",
      }),
    ]);
    const before = await fastify.inject({ method: "GET", url: "/rss/" });
    expect(before.body).toContain("Old Sender");
    const etag = before.headers.etag as string;

    EmailsDataPurgeExpired();

    const after = await fastify.inject({
      method: "GET",
      url: "/rss/",
      headers: { "if-none-match": etag },
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).not.toContain("Old Sender");
  });

  it("serves conditional JSON and HTML index representations that vary on Accept", async () => {
    const fastify = build(configForIsolated());
    const json = await fastify.inject({ method: "GET", url: "/rss/" });
    const html = await fastify.inject({
      method: "GET",
      url: "/rss/",
      headers: { accept: "text/html" },
    });
    expect(json.statusCode).toBe(200);
    expect(html.statusCode).toBe(200);
    expect(json.headers.etag).toBeTruthy();
    expect(html.headers.etag).toBeTruthy();
    expect(json.headers.etag).not.toBe(html.headers.etag);
    expect(String(json.headers.vary).toLowerCase()).toContain("accept");
    expect(String(html.headers.vary).toLowerCase()).toContain("accept");

    const jsonNotModified = await fastify.inject({
      method: "GET",
      url: "/rss/",
      headers: { "if-none-match": json.headers.etag as string },
    });
    expect(jsonNotModified.statusCode).toBe(304);
    const htmlNotModified = await fastify.inject({
      method: "GET",
      url: "/rss/",
      headers: {
        accept: "text/html",
        "if-none-match": html.headers.etag as string,
      },
    });
    expect(htmlNotModified.statusCode).toBe(304);
  });

  it("serves a stable OPML document with validators", async () => {
    const fastify = build(configForIsolated());
    const first = await fastify.inject({ method: "GET", url: "/rss/opml" });
    expect(first.statusCode).toBe(200);
    expect(first.headers.etag).toBeTruthy();
    expect(first.headers["content-disposition"]).toContain("attachment");

    const notModified = await fastify.inject({
      method: "GET",
      url: "/rss/opml",
      headers: { "if-none-match": first.headers.etag as string },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
  });
});

describe("compression", () => {
  let isolatedDir: string;

  beforeEach(() => {
    isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "appbuilder-gzip-"));
    EmailsDataInit(7, isolatedDir);
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: false,
      dataDir: isolatedDir,
    });
    EmailItemsBatchSave([
      makeItem({
        body: `<p>${"Long feed body. ".repeat(200)}</p>`,
      }),
      makeItem({
        id: DAILY_2_ID,
        messageId: "<daily-2@example.com>",
        body: `<p>${"Second long feed body. ".repeat(200)}</p>`,
      }),
    ]);
  });

  afterEach(() => {
    EmailsDataInit(7, dataDir);
    initFeedIdentity();
  });

  function configForIsolated(): Config {
    return makeConfig({ DATA_DIR: isolatedDir });
  }

  it("gzip-compresses feeds and round-trips the identity body", async () => {
    const fastify = build(configForIsolated());
    const identity = await fastify.inject({ method: "GET", url: "/rss/thedaily" });
    expect(identity.statusCode).toBe(200);
    expect(identity.headers["content-encoding"]).toBeUndefined();

    const compressed = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily",
      headers: { "accept-encoding": "gzip" },
    });
    expect(compressed.statusCode).toBe(200);
    expect(compressed.headers["content-encoding"]).toBe("gzip");
    expect(String(compressed.headers.vary).toLowerCase()).toContain(
      "accept-encoding",
    );
    expect(zlib.gunzipSync(compressed.rawPayload).toString("utf8")).toBe(
      identity.body,
    );
  });

  it("brotli-compresses feeds and keeps the ETag stable across encodings", async () => {
    const fastify = build(configForIsolated());
    const identity = await fastify.inject({ method: "GET", url: "/rss/thedaily" });
    const compressed = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily",
      headers: { "accept-encoding": "br" },
    });
    expect(compressed.headers["content-encoding"]).toBe("br");
    expect(zlib.brotliDecompressSync(compressed.rawPayload).toString("utf8")).toBe(
      identity.body,
    );
    expect(compressed.headers.etag).toBe(identity.headers.etag);
  });

  it("answers 304 without a body when the client already has the latest copy", async () => {
    const fastify = build(configForIsolated());
    const identity = await fastify.inject({ method: "GET", url: "/rss/thedaily" });
    const notModified = await fastify.inject({
      method: "GET",
      url: "/rss/thedaily",
      headers: {
        "accept-encoding": "gzip",
        "if-none-match": identity.headers.etag as string,
      },
    });
    expect(notModified.statusCode).toBe(304);
    expect(notModified.body).toBe("");
    expect(notModified.headers["content-encoding"]).toBeUndefined();
  });

  it("leaves tiny responses identity-encoded", async () => {
    const fastify = build(configForIsolated());
    const response = await fastify.inject({
      method: "GET",
      url: "/api/status",
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
  });
});

describe("journal independence at the route level", () => {
  let isolatedDir: string;
  let journalPath: string;

  beforeEach(() => {
    isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), "appbuilder-lo-"));
    journalPath = path.join(isolatedDir, "emails.jsonl");
    EmailsDataInit(7, isolatedDir);
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: false,
      dataDir: isolatedDir,
    });
    EmailItemsBatchSave([makeItem()]);
  });

  afterEach(() => {
    EmailsDataInit(7, dataDir);
    initFeedIdentity();
  });

  it("serves every feed, OPML and view route with the journal moved away", async () => {
    const fastify = build(makeConfig({ DATA_DIR: isolatedDir }));
    const movedPath = `${journalPath}.moved`;
    fs.renameSync(journalPath, movedPath);
    try {
      const urls = [
        "/rss/",
        "/rss/opml",
        "/rss/thedaily",
        `/view/${DAILY_ID}`,
      ];
      for (const url of urls) {
        const response = await fastify.inject({ method: "GET", url });
        expect(response.statusCode).toBe(200);
      }
      const html = await fastify.inject({
        method: "GET",
        url: "/rss/",
        headers: { accept: "text/html" },
      });
      expect(html.statusCode).toBe(200);
      expect(html.body).toContain("The Daily");
      expect(fs.existsSync(journalPath)).toBe(false);
    } finally {
      fs.renameSync(movedPath, journalPath);
    }
  });
});

describe("security headers", () => {
  function scriptHash(body: string): string {
    const match = body.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    return createHash("sha256").update(match![1]).digest("base64");
  }

  it("serves the HTML index with a CSP matching its inline script", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: "/rss/",
      headers: { accept: "text/html" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["content-security-policy"]).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'sha256-${scriptHash(response.body)}'`,
        "style-src 'self' 'unsafe-inline'",
        "img-src http: https: data:",
        "connect-src 'self'",
        "font-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
      ].join("; "),
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    expect(response.headers["referrer-policy"]).toBe("no-referrer");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["permissions-policy"]).toBe(
      "camera=(), microphone=(), geolocation=()",
    );
  });

  it("serves the email view with the same CSP", async () => {
    const response = await build(makeConfig()).inject({
      method: "GET",
      url: `/view/${DAILY_ID}`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(response.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("keeps the CSP and ETag stable across requests", async () => {
    const fastify = build(makeConfig());
    const first = await fastify.inject({
      method: "GET",
      url: "/rss/",
      headers: { accept: "text/html" },
    });
    const second = await fastify.inject({
      method: "GET",
      url: "/rss/",
      headers: { accept: "text/html" },
    });

    expect(second.headers["content-security-policy"]).toBe(
      first.headers["content-security-policy"],
    );
    expect(second.headers.etag).toBe(first.headers.etag);
  });

  it("adds the baseline headers but no CSP to feed, JSON, OPML and status responses", async () => {
    const fastify = build(makeConfig());
    const urls = [
      "/rss/",
      "/rss/opml",
      `/rss/${FeedIdentityGetFeedUrlId("thedaily")}`,
      "/api/status",
    ];
    for (const url of urls) {
      const response = await fastify.inject({ method: "GET", url });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
      expect(response.headers["x-frame-options"]).toBe("DENY");
      expect(response.headers["content-security-policy"]).toBeUndefined();
    }
  });
});
