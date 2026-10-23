import * as fs from "fs";
import * as os from "os";
import path from "path";
import { Config } from "../Config";
import { OTelSetTracer, OTelTracer } from "../OTelContext";
import { StandardTracer } from "@devopsplaybook.io/otel-utils";
import { EmailsDataInit, EmailItemsBatchSave } from "./EmailsData";
import { EmailItem } from "./EmailFetcher";
import { FeedIdentityInit } from "../feeds/FeedIdentity";
import { RssFeedGeneratorBuildFeedById } from "./RssFeedGenerator";

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    messageId: "<msg-1@example.com>",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    subject: "Issue #42",
    body: "<p>Hello <b>world</b><script>alert('xss')</script></p><img src=\"https://tracker.example/p\" width=\"1\" height=\"1\">",
    dateReceived: "2026-10-15T08:00:00.000Z",
    dateCreated: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

let dataDir: string;

beforeAll(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "rssgen-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
  OTelSetTracer(new StandardTracer(new Config()));
});

describe("RssFeedGeneratorBuildFeedById", () => {
  it("emits sanitized content:encoded and a plain-text description", () => {
    EmailItemsBatchSave([makeItem()]);
    const span = OTelTracer().startSpan("test");
    const xml = RssFeedGeneratorBuildFeedById(
      span,
      "thedaily",
      "https://svc.example.com",
    ) as string;
    expect(xml).toContain("<content:encoded>");
    expect(xml).toContain("<p>Hello <b>world</b></p>");
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("tracker.example");
    expect(xml).toContain("<description><![CDATA[Hello world]]></description>");
  });

  it("links items to the view permalink instead of the feed URL", () => {
    EmailItemsBatchSave([makeItem()]);
    const span = OTelTracer().startSpan("test");
    const xml = RssFeedGeneratorBuildFeedById(
      span,
      "thedaily",
      "https://svc.example.com",
    ) as string;
    expect(xml).toContain(
      "<link>https://svc.example.com/view/11111111-1111-4111-8111-111111111111</link>",
    );
  });

  it("declares the newsletter namespace and a ttl", () => {
    EmailItemsBatchSave([makeItem()]);
    const span = OTelTracer().startSpan("test");
    const xml = RssFeedGeneratorBuildFeedById(
      span,
      "thedaily",
      "https://svc.example.com",
    ) as string;
    expect(xml).toContain('xmlns:newsletter="https://github.com/DidierHoarau/feedwatcher-newsletter/ns/1.0"');
    expect(xml).toContain("<ttl>60</ttl>");
    expect(xml).toContain("<newsletter:messageId>");
  });

  it("strips one-dimension tracking pixels by default", () => {
    EmailItemsBatchSave([
      makeItem({
        id: "22222222-2222-4222-8222-222222222222",
        messageId: "<one-dimension@example.com>",
        body: '<p>Hi</p><img src="https://tracker.example/one" width="1">',
      }),
    ]);
    const span = OTelTracer().startSpan("test");
    const xml = RssFeedGeneratorBuildFeedById(
      span,
      "thedaily",
      "https://svc.example.com",
    ) as string;
    expect(xml).not.toContain("tracker.example/one");
  });

  it("keeps tracking pixels when stripping is disabled", () => {
    EmailItemsBatchSave([
      makeItem({
        id: "33333333-3333-4333-8333-333333333333",
        messageId: "<keep-pixel@example.com>",
        body: '<p>Hi</p><img src="https://tracker.example/keep" width="1">',
      }),
    ]);
    const span = OTelTracer().startSpan("test");
    const xml = RssFeedGeneratorBuildFeedById(
      span,
      "thedaily",
      "https://svc.example.com",
      false,
    ) as string;
    expect(xml).toContain("tracker.example/keep");
  });

  it("returns undefined for an unknown feed id and creates no token", () => {
    const tokensDir = fs.mkdtempSync(path.join(os.tmpdir(), "rssgen-tokens-"));
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: true,
      dataDir: tokensDir,
    });
    try {
      const span = OTelTracer().startSpan("test");
      const xml = RssFeedGeneratorBuildFeedById(
        span,
        "ghostfeed",
        "https://svc.example.com",
      );
      expect(xml).toBeUndefined();
      expect(fs.existsSync(path.join(tokensDir, "feed-tokens.json"))).toBe(
        false,
      );
    } finally {
      FeedIdentityInit({
        ignoreList: "",
        overrides: {},
        privateUrls: false,
        dataDir,
      });
    }
  });
});
