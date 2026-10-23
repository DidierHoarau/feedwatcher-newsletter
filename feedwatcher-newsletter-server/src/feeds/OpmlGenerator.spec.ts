import { OpmlGeneratorBuild } from "./OpmlGenerator";

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
  const dateCreated = new Date("2026-10-22T10:00:00.000Z");

  it("emits an OPML 2.0 document with one outline per feed", () => {
    const xml = OpmlGeneratorBuild(
      "My feeds",
      "https://svc.example.com",
      [
        makeEntry(),
        makeEntry({
          title: "Morning Brew",
          feedUrl: "https://svc.example.com/rss/morningbrew.abc123",
        }),
      ],
      dateCreated,
    );
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain('type="rss"');
    expect(xml).toContain('text="The Daily Newsletter"');
    expect(xml).toContain('xmlUrl="https://svc.example.com/rss/thedailynewsletter"');
    expect(xml).toContain('xmlUrl="https://svc.example.com/rss/morningbrew.abc123"');
    expect(xml).toContain("<dateCreated>Thu, 22 Oct 2026 10:00:00 GMT</dateCreated>");
  });

  it("is deterministic for the supplied creation date", () => {
    const first = OpmlGeneratorBuild("Feeds", "https://svc.example.com", [makeEntry()], dateCreated);
    const second = OpmlGeneratorBuild("Feeds", "https://svc.example.com", [makeEntry()], dateCreated);
    expect(second).toBe(first);
  });

  it("escapes special characters in titles", () => {
    const xml = OpmlGeneratorBuild(
      "Feeds",
      "https://svc.example.com",
      [makeEntry({ title: 'AT&T <News>' })],
      dateCreated,
    );
    expect(xml).toContain('text="AT&amp;T &lt;News&gt;"');
    expect(xml).not.toContain('text="AT&T');
  });
});
