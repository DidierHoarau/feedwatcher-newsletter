import { OpmlGeneratorBuild } from "./OpmlGenerator";

function makeEntry(
  overrides: Partial<{ feedId: string; title: string; feedUrl: string }> = {},
): { feedId: string; title: string; feedUrl: string } {
  return {
    feedId: "thedailynewsletter",
    title: "The Daily Newsletter",
    feedUrl: "https://svc.example.com/rss/thedailynewsletter",
    ...overrides,
  };
}

describe("OpmlGeneratorBuild", () => {
  const dateCreated = new Date("2026-10-22T10:00:00.000Z");

  it("emits an OPML 2.0 document with one outline per feed in a Newsletters folder", () => {
    const xml = OpmlGeneratorBuild(
      "My feeds",
      "https://svc.example.com",
      [
        makeEntry(),
        makeEntry({
          feedId: "morningbrew",
          title: "Morning Brew",
          feedUrl: "https://svc.example.com/rss/morningbrew.abc123",
        }),
      ],
      dateCreated,
    );
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<opml version="2.0">');
    expect(xml).toContain('<outline text="Newsletters" title="Newsletters">');
    expect(xml).toContain('type="rss"');
    expect(xml).toContain('text="The Daily Newsletter"');
    expect(xml).toContain(
      'xmlUrl="https://svc.example.com/rss/thedailynewsletter"',
    );
    expect(xml).toContain(
      'xmlUrl="https://svc.example.com/rss/morningbrew.abc123"',
    );
    expect(xml).toContain("<dateCreated>Thu, 22 Oct 2026 10:00:00 GMT</dateCreated>");
  });

  it("orders outlines by title, then by feedId for equal titles", () => {
    const xml = OpmlGeneratorBuild(
      "Feeds",
      "https://svc.example.com",
      [
        makeEntry({ feedId: "z", title: "Same", feedUrl: "https://svc.example.com/rss/z" }),
        makeEntry({ feedId: "thetitle", title: "The title", feedUrl: "https://svc.example.com/rss/thetitle" }),
        makeEntry({ feedId: "a", title: "Same", feedUrl: "https://svc.example.com/rss/a" }),
      ],
      dateCreated,
    );
    // "Same" sorts before "The title"; equal titles tie-break on feedId.
    const sameA = xml.indexOf('xmlUrl="https://svc.example.com/rss/a"');
    const sameZ = xml.indexOf('xmlUrl="https://svc.example.com/rss/z"');
    const theTitle = xml.indexOf('xmlUrl="https://svc.example.com/rss/thetitle"');
    expect(sameA).toBeGreaterThan(-1);
    expect(sameA).toBeLessThan(sameZ);
    expect(sameZ).toBeLessThan(theTitle);
  });

  it("is deterministic for the supplied creation date", () => {
    const first = OpmlGeneratorBuild("Feeds", "https://svc.example.com", [makeEntry()], dateCreated);
    const second = OpmlGeneratorBuild("Feeds", "https://svc.example.com", [makeEntry()], dateCreated);
    expect(second).toBe(first);
  });

  it("is deterministic regardless of the caller's order", () => {
    const a = makeEntry({ feedId: "m", title: "Alpha" });
    const b = makeEntry({ feedId: "thedailynewsletter", title: "The Daily Newsletter" });
    const first = OpmlGeneratorBuild("Feeds", "https://svc.example.com", [a, b], dateCreated);
    const second = OpmlGeneratorBuild("Feeds", "https://svc.example.com", [b, a], dateCreated);
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
