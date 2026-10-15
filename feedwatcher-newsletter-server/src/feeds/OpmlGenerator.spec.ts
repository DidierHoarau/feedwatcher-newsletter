import { OpmlGeneratorBuild } from "./OpmlGenerator";

function makeFeed(overrides: Partial<FeedSummary> = {}): FeedSummary {
  return {
    feedId: "thedailynewsletter",
    title: "The Daily Newsletter",
    senderName: "The Daily Newsletter",
    senderEmail: "news@example.com",
    itemCount: 5,
    latestDate: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

function makeEntry(overrides: Partial<{ title: string; feedUrl: string }> = {}): {
  title: string;
  feedUrl: string;
} {
  return {
    title: "The Daily Newsletter",
    feedUrl: "https://svc.example.com/rss/thedailynewsletter",
    ...overrides,
  };
}

describe("OpmlGeneratorBuild", () => {
  it("emits an OPML 2.0 document with one outline per feed", () => {
    const xml = OpmlGeneratorBuild("My feeds", "https://svc.example.com", [
      makeEntry(),
      makeEntry({
        title: "Morning Brew",
        feedUrl: "https://svc.example.com/rss/morningbrew.abc123",
      }),
    ]);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain('type="rss"');
    expect(xml).toContain('text="The Daily Newsletter"');
    expect(xml).toContain('xmlUrl="https://svc.example.com/rss/thedailynewsletter"');
    expect(xml).toContain('xmlUrl="https://svc.example.com/rss/morningbrew.abc123"');
  });

  it("escapes special characters in titles", () => {
    const xml = OpmlGeneratorBuild("Feeds", "https://svc.example.com", [
      makeEntry({ title: 'AT&T <News>' }),
    ]);
    expect(xml).toContain('text="AT&amp;T &lt;News&gt;"');
    expect(xml).not.toContain('text="AT&T');
  });
});
