import { COPY_SCRIPT, renderFeedsIndexPage } from "./HtmlPages";

function makeFeed(overrides: Partial<{
  feedUrl: string;
  title: string;
  senderName: string;
  senderEmail: string;
  itemCount: number;
  latestDate: string;
}> = {}) {
  return {
    feedUrl: "https://svc.example.com/rss/thedaily.abc123",
    title: "The Daily",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    itemCount: 2,
    latestDate: "2026-10-16T08:00:00.000Z",
    ...overrides,
  };
}

function alternateLinks(html: string): string[] {
  return html.match(/<link rel="alternate"[^>]*>/g) || [];
}

describe("renderFeedsIndexPage", () => {
  it("emits one autodiscovery link per feed", () => {
    const html = renderFeedsIndexPage([
      makeFeed(),
      makeFeed({
        feedUrl: "https://svc.example.com/rss/morningbrew.def456",
        title: "Morning Brew",
        senderName: "Morning Brew",
        senderEmail: "brew@morningbrew.com",
      }),
    ]);
    const links = alternateLinks(html);
    expect(links).toHaveLength(2);
    expect(links[0]).toBe(
      '<link rel="alternate" type="application/rss+xml" title="The Daily" href="https://svc.example.com/rss/thedaily.abc123"/>',
    );
    expect(links[1]).toContain('title="Morning Brew"');
    expect(links[1]).toContain(
      'href="https://svc.example.com/rss/morningbrew.def456"',
    );
  });

  it("escapes attribute values in the discovery links", () => {
    const html = renderFeedsIndexPage([
      makeFeed({ title: 'A & B "C"', feedUrl: "https://svc.example.com/rss/x?a=1&b=2" }),
    ]);
    const link = alternateLinks(html)[0];
    expect(link).toContain('title="A &amp; B &quot;C&quot;"');
    expect(link).toContain('href="https://svc.example.com/rss/x?a=1&amp;b=2"');
  });

  it("emits no discovery link for an empty feed list", () => {
    const html = renderFeedsIndexPage([]);
    expect(alternateLinks(html)).toHaveLength(0);
    expect(html).toContain("0 newsletter feed(s) available");
  });

  it("keeps the copy script on the index page", () => {
    const html = renderFeedsIndexPage([makeFeed()]);
    expect(html).toContain(`<script>${COPY_SCRIPT}</script>`);
  });
});
