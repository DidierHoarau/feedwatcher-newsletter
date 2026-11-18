import {
  FEED_CATALOGUE_VERSION,
  FeedCatalogueBuild,
  FeedCatalogueHealth,
} from "./FeedCatalogue";
import { FeedListEntry } from "./FeedListing";

const NOW = Date.parse("2026-11-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function makeHealth(
  overrides: Partial<FeedCatalogueHealth> = {},
): FeedCatalogueHealth {
  return {
    status: "ok",
    staleAfterSeconds: 7200,
    quietAfterDays: 7,
    lastSuccessfulFetchAt: "2026-11-18T11:00:00.000Z",
    idle: { enabled: true, connected: true },
    lastError: null,
    storageFresh: false,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<FeedListEntry> = {}): FeedListEntry {
  return {
    feedId: "thedaily",
    title: "The Daily",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    itemCount: 2,
    servedItemCount: 2,
    latestDate: "2026-10-16T08:00:00.000Z",
    feedUrl: "https://svc.example.com/rss/thedaily.abc123",
    archiveUrl: "https://svc.example.com/rss/thedaily.abc123/archive",
    ...overrides,
  };
}

interface ParsedCatalogue {
  version: number;
  health: FeedCatalogueHealth;
  feeds: Record<string, unknown>[];
}

function parse(body: string): ParsedCatalogue {
  return JSON.parse(body);
}

describe("FeedCatalogueBuild", () => {
  it("emits version 1 with the health block and the additive per-feed fields", () => {
    const catalogue = parse(
      FeedCatalogueBuild([makeEntry()], makeHealth(), NOW),
    );
    expect(FEED_CATALOGUE_VERSION).toBe(1);
    expect(catalogue.version).toBe(1);
    expect(catalogue.health).toEqual(makeHealth());
    expect(catalogue.feeds).toHaveLength(1);
    expect(Object.keys(catalogue.feeds[0]).sort()).toEqual(
      [
        "feedId",
        "title",
        "senderName",
        "senderEmail",
        "itemCount",
        "servedItemCount",
        "latestDate",
        "feedUrl",
        "archiveUrl",
        "lastEmailAt",
        "quiet",
      ].sort(),
    );
    expect(catalogue.feeds[0]).toEqual({
      feedId: "thedaily",
      title: "The Daily",
      senderName: "The Daily",
      senderEmail: "news@example.com",
      itemCount: 2,
      servedItemCount: 2,
      latestDate: "2026-10-16T08:00:00.000Z",
      feedUrl: "https://svc.example.com/rss/thedaily.abc123",
      archiveUrl: "https://svc.example.com/rss/thedaily.abc123/archive",
      lastEmailAt: "2026-10-16T08:00:00.000Z",
      quiet: true,
    });
  });

  it("marks a feed quiet only after seven days without an email", () => {
    const catalogue = parse(
      FeedCatalogueBuild(
        [
          makeEntry({ feedId: "quiet", title: "Quiet" }),
          makeEntry({
            feedId: "active",
            title: "Active",
            latestDate: new Date(NOW - 2 * DAY).toISOString(),
          }),
        ],
        makeHealth(),
        NOW,
      ),
    );
    const quiet = catalogue.feeds.find((feed) => feed.feedId === "quiet");
    const active = catalogue.feeds.find((feed) => feed.feedId === "active");
    expect(quiet?.quiet).toBe(true);
    expect(active?.quiet).toBe(false);
    expect(active?.lastEmailAt).toBe(active?.latestDate);
  });

  it("does not leak extra internal fields", () => {
    const entry = { ...makeEntry(), internalOnly: "secret" } as FeedListEntry;
    const catalogue = parse(FeedCatalogueBuild([entry], makeHealth(), NOW));
    expect(catalogue.feeds[0]).not.toHaveProperty("internalOnly");
  });

  it("orders by title, then by feedId for equal titles", () => {
    const catalogue = parse(
      FeedCatalogueBuild(
        [
          makeEntry({ feedId: "z", title: "Same" }),
          makeEntry({ feedId: "m", title: "Alpha" }),
          makeEntry({ feedId: "a", title: "Same" }),
        ],
        makeHealth(),
        NOW,
      ),
    );
    expect(catalogue.feeds.map((feed) => [feed.title, feed.feedId])).toEqual([
      ["Alpha", "m"],
      ["Same", "a"],
      ["Same", "z"],
    ]);
  });

  it("returns an empty feed list with the health block for no entries", () => {
    const catalogue = parse(FeedCatalogueBuild([], makeHealth(), NOW));
    expect(catalogue.version).toBe(1);
    expect(catalogue.health).toEqual(makeHealth());
    expect(catalogue.feeds).toEqual([]);
  });

  it("is byte-identical for the same input regardless of input order", () => {
    const first = makeEntry({ feedId: "m", title: "Alpha" });
    const second = makeEntry({ feedId: "thedaily", title: "The Daily" });
    expect(FeedCatalogueBuild([first, second], makeHealth(), NOW)).toBe(
      FeedCatalogueBuild([second, first], makeHealth(), NOW),
    );
  });

  it("stays compatible with a reader that only knows the original v1 fields", () => {
    const catalogue = parse(
      FeedCatalogueBuild([makeEntry()], makeHealth(), NOW),
    );
    const consumer = (body: ParsedCatalogue) =>
      body.feeds.map((feed) => ({
        feedId: feed.feedId,
        title: feed.title,
        senderName: feed.senderName,
        senderEmail: feed.senderEmail,
        itemCount: feed.itemCount,
        servedItemCount: feed.servedItemCount,
        latestDate: feed.latestDate,
        feedUrl: feed.feedUrl,
        archiveUrl: feed.archiveUrl,
      }));
    expect(consumer(catalogue)).toEqual([
      {
        feedId: "thedaily",
        title: "The Daily",
        senderName: "The Daily",
        senderEmail: "news@example.com",
        itemCount: 2,
        servedItemCount: 2,
        latestDate: "2026-10-16T08:00:00.000Z",
        feedUrl: "https://svc.example.com/rss/thedaily.abc123",
        archiveUrl: "https://svc.example.com/rss/thedaily.abc123/archive",
      },
    ]);
    // Unknown fields are additive at version 1: the contract version is
    // unchanged and the original fields keep their types.
    expect(catalogue.version).toBe(1);
  });
});
