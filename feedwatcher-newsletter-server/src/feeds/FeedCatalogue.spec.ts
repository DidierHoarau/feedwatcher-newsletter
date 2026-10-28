import { FEED_CATALOGUE_VERSION, FeedCatalogueBuild } from "./FeedCatalogue";
import { FeedListEntry } from "./FeedListing";

function makeEntry(overrides: Partial<FeedListEntry> = {}): FeedListEntry {
  return {
    feedId: "thedaily",
    title: "The Daily",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    itemCount: 2,
    latestDate: "2026-10-16T08:00:00.000Z",
    feedUrl: "https://svc.example.com/rss/thedaily.abc123",
    ...overrides,
  };
}

function parse(body: string): {
  version: number;
  feeds: Record<string, unknown>[];
} {
  return JSON.parse(body);
}

describe("FeedCatalogueBuild", () => {
  it("emits version 1 with exactly the contract fields", () => {
    const catalogue = parse(FeedCatalogueBuild([makeEntry()]));
    expect(FEED_CATALOGUE_VERSION).toBe(1);
    expect(catalogue.version).toBe(1);
    expect(catalogue.feeds).toHaveLength(1);
    expect(Object.keys(catalogue.feeds[0]).sort()).toEqual(
      [
        "feedId",
        "title",
        "senderName",
        "senderEmail",
        "itemCount",
        "latestDate",
        "feedUrl",
      ].sort(),
    );
    expect(catalogue.feeds[0]).toEqual({
      feedId: "thedaily",
      title: "The Daily",
      senderName: "The Daily",
      senderEmail: "news@example.com",
      itemCount: 2,
      latestDate: "2026-10-16T08:00:00.000Z",
      feedUrl: "https://svc.example.com/rss/thedaily.abc123",
    });
  });

  it("does not leak extra internal fields", () => {
    const entry = { ...makeEntry(), internalOnly: "secret" } as FeedListEntry;
    const catalogue = parse(FeedCatalogueBuild([entry]));
    expect(catalogue.feeds[0]).not.toHaveProperty("internalOnly");
  });

  it("orders by title, then by feedId for equal titles", () => {
    const catalogue = parse(
      FeedCatalogueBuild([
        makeEntry({ feedId: "z", title: "Same" }),
        makeEntry({ feedId: "m", title: "Alpha" }),
        makeEntry({ feedId: "a", title: "Same" }),
      ]),
    );
    expect(catalogue.feeds.map((feed) => [feed.title, feed.feedId])).toEqual([
      ["Alpha", "m"],
      ["Same", "a"],
      ["Same", "z"],
    ]);
  });

  it("returns an empty feed list for no entries", () => {
    expect(FeedCatalogueBuild([])).toBe('{"version":1,"feeds":[]}');
  });

  it("is byte-identical for the same input regardless of input order", () => {
    const first = makeEntry({ feedId: "m", title: "Alpha" });
    const second = makeEntry({ feedId: "thedaily", title: "The Daily" });
    expect(FeedCatalogueBuild([first, second])).toBe(
      FeedCatalogueBuild([second, first]),
    );
  });
});
