import { EmailItem } from "../emails/EmailFetcher";
import {
  COPY_SCRIPT,
  renderFeedArchivePage,
  renderFeedsIndexPage,
  renderViewPage,
} from "./HtmlPages";

function makeEmail(overrides: Partial<EmailItem> = {}): EmailItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    messageId: "<msg-1@example.com>",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    subject: "Daily issue",
    body: "<p>Body</p>",
    dateReceived: "2026-10-15T08:00:00.000Z",
    dateCreated: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

function makeFeed(overrides: Partial<{
  feedUrl: string;
  archiveUrl: string;
  title: string;
  senderName: string;
  senderEmail: string;
  itemCount: number;
  servedItemCount: number;
  latestDate: string;
}> = {}) {
  return {
    feedUrl: "https://svc.example.com/rss/thedaily.abc123",
    archiveUrl: "https://svc.example.com/rss/thedaily.abc123/archive",
    title: "The Daily",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    itemCount: 2,
    servedItemCount: 2,
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

  it("links one escaped archive URL per feed", () => {
    const html = renderFeedsIndexPage([
      makeFeed(),
      makeFeed({
        feedUrl: "https://svc.example.com/rss/x?a=1&b=2",
        archiveUrl: "https://svc.example.com/rss/x?a=1&b=2/archive",
        title: "A & B",
      }),
    ]);
    const archives = html.match(/<a class="archive"[^>]*>/g) || [];
    expect(archives).toHaveLength(2);
    expect(archives[0]).toBe(
      '<a class="archive" href="https://svc.example.com/rss/thedaily.abc123/archive">',
    );
    expect(archives[1]).toContain(
      'href="https://svc.example.com/rss/x?a=1&amp;b=2/archive"',
    );
    expect(html).not.toContain('href="https://svc.example.com/rss/x?a=1&b=2/archive"');
  });

  it("shows the served window when the feed is capped and the total otherwise", () => {
    const capped = renderFeedsIndexPage([
      makeFeed({ itemCount: 5, servedItemCount: 2 }),
    ]);
    expect(capped).toContain("2 of 5 email(s) in the feed");

    const full = renderFeedsIndexPage([
      makeFeed({ itemCount: 5, servedItemCount: 5 }),
    ]);
    expect(full).toContain("5 email(s)");
    expect(full).not.toContain("of 5 email(s) in the feed");
  });
});

describe("renderFeedArchivePage", () => {
  const items = [
    {
      id: "22222222-2222-4222-8222-222222222222",
      subject: "Newer issue",
      date: "2026-10-16T08:00:00.000Z",
      senderName: "The Daily",
      senderEmail: "news@example.com",
      summary: "Newer summary",
    },
    {
      id: "11111111-1111-4111-8111-111111111111",
      subject: "Older issue",
      date: "2026-10-15T08:00:00.000Z",
      senderName: "The Daily",
      senderEmail: "news@example.com",
      summary: "Older summary",
    },
  ];

  it("lists every supplied item in order with a permalink", () => {
    const html = renderFeedArchivePage(
      {
        title: "The Daily",
        feedUrl: "https://svc.example.com/rss/thedaily.abc123",
        archiveUrl: "https://svc.example.com/rss/thedaily.abc123/archive",
      },
      items,
      2,
    );
    expect(html.indexOf("Newer issue")).toBeLessThan(
      html.indexOf("Older issue"),
    );
    expect(html).toContain(
      '<a href="/view/22222222-2222-4222-8222-222222222222">Newer issue</a>',
    );
    expect(html).toContain(
      '<a href="/view/11111111-1111-4111-8111-111111111111">Older issue</a>',
    );
    expect(html).toContain("Newer summary");
    expect(html).toContain("Older summary");
    expect(html).toContain("Fri, 16 Oct 2026 08:00:00 GMT");
    expect(html).toContain("2 retained email(s). The RSS feed serves the newest 2.");
    expect(html).toContain(
      '<a class="rss-feed" href="https://svc.example.com/rss/thedaily.abc123">RSS feed</a>',
    );
    expect(html).toContain('<a class="back" href="/rss/">&larr; All feeds</a>');
  });

  it("escapes every item field and ships no script", () => {
    const html = renderFeedArchivePage(
      {
        title: 'A & B "C"',
        feedUrl: "https://svc.example.com/rss/x?a=1&b=2",
        archiveUrl: "https://svc.example.com/rss/x?a=1&b=2/archive",
      },
      [
        {
          id: "id-1",
          subject: "<script>alert(1)</script>",
          date: "2026-10-15T08:00:00.000Z",
          senderName: "A & B",
          senderEmail: "a&b@example.com",
          summary: "<b>Summary & more</b>",
        },
      ],
      1,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("A &amp; B");
    expect(html).toContain("a&amp;b@example.com");
    expect(html).toContain("&lt;b&gt;Summary &amp; more&lt;/b&gt;");
    expect(html).toContain('href="https://svc.example.com/rss/x?a=1&amp;b=2"');
    expect(html).toContain("A &amp; B &quot;C&quot;");
    expect(html).not.toContain("<script");
  });
});

describe("renderViewPage", () => {
  it("renders the feed and newer/older navigation", () => {
    const html = renderViewPage(makeEmail(), "<p>Body</p>", {
      feed: { url: "https://svc.example.com/rss/thedaily.abc123", title: "The Daily" },
      previous: {
        id: "22222222-2222-4222-8222-222222222222",
        subject: "Newer issue",
      },
      next: {
        id: "33333333-3333-4333-8333-333333333333",
        subject: "Older issue",
      },
    });
    expect(html).toContain(
      '<nav class="email-nav" aria-label="Email navigation">',
    );
    expect(html).toContain(
      '<a class="nav-feed" href="https://svc.example.com/rss/thedaily.abc123">Feed: The Daily</a>',
    );
    expect(html).toContain(
      '<a class="nav-archive" href="https://svc.example.com/rss/thedaily.abc123/archive">Archive</a>',
    );
    expect(html).toContain(
      '<a class="nav-newer" href="/view/22222222-2222-4222-8222-222222222222">&larr; Newer: Newer issue</a>',
    );
    expect(html).toContain(
      '<a class="nav-older" href="/view/33333333-3333-4333-8333-333333333333">Older: Older issue &rarr;</a>',
    );
    expect(html).toContain('<a class="back" href="/rss/">&larr; All feeds</a>');
  });

  it("escapes navigation subjects and URLs", () => {
    const html = renderViewPage(makeEmail(), "<p>Body</p>", {
      feed: {
        url: "https://svc.example.com/rss/x?a=1&b=2",
        title: 'A & B "C"',
      },
      previous: { id: "id-1", subject: "<script>alert(1)</script>" },
    });
    expect(html).toContain(
      'href="https://svc.example.com/rss/x?a=1&amp;b=2">Feed: A &amp; B &quot;C&quot;',
    );
    expect(html).toContain(
      '<a class="nav-archive" href="https://svc.example.com/rss/x?a=1&amp;b=2/archive">Archive</a>',
    );
    expect(html).toContain(
      "&larr; Newer: &lt;script&gt;alert(1)&lt;/script&gt;",
    );
    expect(html).not.toContain("<script>alert(1)</script>");
  });

  it("omits the navigation when there is no feed or neighbour", () => {
    const html = renderViewPage(makeEmail(), "<p>Body</p>", {});
    expect(html).not.toContain('class="email-nav"');
    expect(html).not.toContain('class="nav-newer"');
    expect(html).not.toContain('class="nav-older"');
    expect(html).not.toContain('class="nav-feed"');
    expect(html).not.toContain('class="nav-archive"');
    expect(html).toContain('<a class="back" href="/rss/">&larr; All feeds</a>');
  });

  it("renders each neighbour independently", () => {
    const newerOnly = renderViewPage(makeEmail(), "<p>Body</p>", {
      previous: { id: "p", subject: "Newer" },
    });
    expect(newerOnly).toContain('class="nav-newer"');
    expect(newerOnly).not.toContain('class="nav-older"');

    const olderOnly = renderViewPage(makeEmail(), "<p>Body</p>", {
      next: { id: "n", subject: "Older" },
    });
    expect(olderOnly).toContain('class="nav-older"');
    expect(olderOnly).not.toContain('class="nav-newer"');
  });

  it("has no script so the hash-based CSP stays unchanged", () => {
    const html = renderViewPage(makeEmail(), "<p>Body</p>", {
      feed: { url: "https://svc.example.com/rss/thedaily", title: "The Daily" },
    });
    expect(html).not.toContain("<script");
    expect(html).toContain("aria-label=\"Email navigation\"");
  });
});
