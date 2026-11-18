import * as fs from "fs";
import * as os from "os";
import path from "path";
import { Config } from "../Config";
import {
  EmailItemsBatchSave,
  EmailsDataInit,
} from "../emails/EmailsData";
import { EmailItem } from "../emails/EmailFetcher";
import { SanitizedBodyCacheGet } from "../emails/SanitizedBodyCache";
import { FeedIdentityInit } from "../feeds/FeedIdentity";
import { FeedSettingsSave } from "../feeds/FeedSettings";
import {
  FEED_INDEX_PREVIEW_ITEMS,
  FeedListingFilter,
  FeedListingGetPreview,
  FeedListingNormalizeQuery,
  FeedListingSortByRecent,
} from "./FeedListing";

jest.mock("../emails/SanitizedBodyCache", () => ({
  SanitizedBodyCacheGet: jest.fn(
    (item: { id: string }) => ({ html: "", summary: `summary:${item.id}` }),
  ),
  SanitizedBodyCacheEvict: jest.fn(),
  SanitizedBodyCacheReset: jest.fn(),
  SanitizedBodyCacheStats: jest.fn(() => ({ entries: 0, bytes: 0 })),
}));

const cacheGetMock = SanitizedBodyCacheGet as unknown as jest.Mock;

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    messageId: "<daily-1@example.com>",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    subject: "Daily issue",
    body: "<p>Daily body</p>",
    dateReceived: "2026-10-15T08:00:00.000Z",
    dateCreated: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

interface Row {
  feedId: string;
  title: string;
  senderName: string;
  senderEmail: string;
}

function row(overrides: Partial<Row> = {}): Row {
  return {
    feedId: "thedaily",
    title: "The Daily",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    ...overrides,
  };
}

let dataDir: string;
let config: Config;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedlisting-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
  FeedSettingsSave({ version: 1, feeds: {} });
  config = Object.assign(new Config(), { DATA_DIR: dataDir });
  EmailItemsBatchSave([
    makeItem({
      id: "11111111-1111-4111-8111-111111111111",
      messageId: "<daily-1@example.com>",
      dateReceived: "2026-10-15T08:00:00.000Z",
      dateCreated: "2026-10-15T08:00:00.000Z",
    }),
    makeItem({
      id: "22222222-2222-4222-8222-222222222222",
      messageId: "<daily-2@example.com>",
      subject: "Second daily issue",
      dateReceived: "2026-10-16T08:00:00.000Z",
      dateCreated: "2026-10-16T08:00:00.000Z",
    }),
    makeItem({
      id: "33333333-3333-4333-8333-333333333333",
      messageId: "<daily-3@example.com>",
      subject: "Third daily issue",
      dateReceived: "2026-10-17T08:00:00.000Z",
      dateCreated: "2026-10-17T08:00:00.000Z",
    }),
  ]);
  cacheGetMock.mockClear();
});

describe("FeedListingNormalizeQuery", () => {
  it("trims, caps and ignores non-string values", () => {
    expect(FeedListingNormalizeQuery("  brew  ")).toBe("brew");
    expect(FeedListingNormalizeQuery(undefined)).toBe("");
    expect(FeedListingNormalizeQuery(["brew"])).toBe("");
    expect(FeedListingNormalizeQuery(42)).toBe("");
    expect(FeedListingNormalizeQuery("x".repeat(500))).toHaveLength(200);
  });
});

describe("FeedListingFilter", () => {
  const feeds = [
    row({ feedId: "thedaily", title: "The Daily" }),
    row({
      feedId: "morningbrew",
      title: "Morning Brew",
      senderName: "Brew Crew",
      senderEmail: "brew@morningbrew.com",
    }),
  ];

  it("matches title, sender name, sender email and feed id case-insensitively", () => {
    expect(FeedListingFilter(feeds, "DAILY").map((f) => f.feedId)).toEqual([
      "thedaily",
    ]);
    expect(FeedListingFilter(feeds, "brew crew").map((f) => f.feedId)).toEqual([
      "morningbrew",
    ]);
    expect(
      FeedListingFilter(feeds, "morningbrew.com").map((f) => f.feedId),
    ).toEqual(["morningbrew"]);
    expect(FeedListingFilter(feeds, "thedaily").map((f) => f.feedId)).toEqual([
      "thedaily",
    ]);
  });

  it("returns every feed for an empty or blank query", () => {
    expect(FeedListingFilter(feeds, "")).toHaveLength(2);
    expect(FeedListingFilter(feeds, "   ")).toHaveLength(2);
    expect(FeedListingFilter(feeds, "nomatch")).toEqual([]);
  });
});

describe("FeedListingSortByRecent", () => {
  it("orders by latest date descending with a title/feedId tie-break", () => {
    const sorted = FeedListingSortByRecent([
      { ...row({ feedId: "old", title: "Old" }), latestDate: "2026-10-01T00:00:00.000Z" },
      { ...row({ feedId: "b", title: "Bravo" }), latestDate: "2026-10-05T00:00:00.000Z" },
      { ...row({ feedId: "a", title: "Alpha" }), latestDate: "2026-10-05T00:00:00.000Z" },
      { ...row({ feedId: "new", title: "New" }), latestDate: "2026-10-09T00:00:00.000Z" },
    ]);
    expect(sorted.map((feed) => feed.feedId)).toEqual(["new", "a", "b", "old"]);
  });

  it("sorts invalid dates last and does not mutate the input", () => {
    const input = [
      { ...row({ feedId: "invalid", title: "Invalid" }), latestDate: "nope" },
      { ...row({ feedId: "valid", title: "Valid" }), latestDate: "2026-10-05T00:00:00.000Z" },
    ];
    const sorted = FeedListingSortByRecent(input);
    expect(sorted.map((feed) => feed.feedId)).toEqual(["valid", "invalid"]);
    expect(input.map((feed) => feed.feedId)).toEqual(["invalid", "valid"]);
  });
});

describe("FeedListingGetPreview", () => {
  it("returns the newest retained items, at most two", () => {
    expect(FEED_INDEX_PREVIEW_ITEMS).toBe(2);
    const preview = FeedListingGetPreview("thedaily", config);
    expect(preview.map((item) => item.subject)).toEqual([
      "Third daily issue",
      "Second daily issue",
    ]);
    expect(preview[0].summary).toBe(`summary:${preview[0].id}`);
    expect(preview[0].date).toBe("2026-10-17T08:00:00.000Z");
  });

  it("honours an explicit limit and an empty feed", () => {
    expect(FeedListingGetPreview("thedaily", config, 1)).toHaveLength(1);
    expect(FeedListingGetPreview("thedaily", config, 0)).toEqual([]);
    expect(FeedListingGetPreview("ghost", config)).toEqual([]);
  });

  it("resolves the per-feed sanitizer flags over the environment defaults", () => {
    FeedSettingsSave({
      version: 1,
      feeds: { thedaily: { stripTrackingPixels: true, blockRemoteImages: true } },
    });
    config.EMAIL_STRIP_TRACKING_PIXELS = false;
    config.EMAIL_BLOCK_REMOTE_IMAGES = false;

    FeedListingGetPreview("thedaily", config);

    expect(cacheGetMock).toHaveBeenCalled();
    for (const call of cacheGetMock.mock.calls) {
      expect(call[1]).toBe(true);
      expect(call[2]).toBe(true);
    }
  });

  it("uses the environment defaults when the feed has no override", () => {
    config.EMAIL_STRIP_TRACKING_PIXELS = false;
    config.EMAIL_BLOCK_REMOTE_IMAGES = true;
    FeedListingGetPreview("thedaily", config);
    for (const call of cacheGetMock.mock.calls) {
      expect(call[1]).toBe(false);
      expect(call[2]).toBe(true);
    }
  });
});
