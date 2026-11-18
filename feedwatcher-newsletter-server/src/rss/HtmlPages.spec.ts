import { EmailItem } from "../emails/EmailFetcher";
import {
  COPY_SCRIPT,
  renderFeedArchivePage,
  renderFeedsIndexPage,
  renderManagePage,
  renderStatusPage,
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

describe("renderManagePage", () => {
  function makeModel(overrides: Record<string, unknown> = {}) {
    return {
      csrfToken: "a".repeat(64),
      feeds: [
        {
          feedId: "thedaily",
          titlePlaceholder: "The Daily",
          senderEmail: "news@example.com",
          itemCount: 2,
          hidden: true,
          mergedInto: "everything",
          setting: {
            title: "Daily Brief",
            hidden: true,
            maxItems: 3,
            blockRemoteImages: false,
          },
        },
      ],
      senders: [{ match: "news@example.com", feedId: "daily-news", title: "News" }],
      defaults: {
        maxItems: 200,
        blockRemoteImages: true,
        stripTrackingPixels: true,
      },
      saved: false,
      ...overrides,
    };
  }

  it("renders the feed form with values, markers and effective defaults", () => {
    const html = renderManagePage(makeModel());
    expect(html).toContain('method="post" action="/manage"');
    expect(html).toContain(`name="csrf" value="${"a".repeat(64)}"`);
    expect(html).toContain('name="feed.thedaily.title" value="Daily Brief"');
    expect(html).toContain("(hidden)");
    expect(html).toContain("(merged into everything)");
    expect(html).toContain('name="feed.thedaily.maxItems"');
    expect(html).toContain('placeholder="inherit (200)"');
    expect(html).toContain("2 retained email(s)");
    expect(html).toContain(
      '<option value="false" selected>off</option>',
    );
    expect(html).not.toContain("<script");
  });

  it("escapes injected values from settings and sender data", () => {
    const html = renderManagePage(
      makeModel({
        feeds: [
          {
            feedId: "thedaily",
            titlePlaceholder: '<b>"Daily"</b>',
            hidden: false,
            setting: { title: '<img src=x onerror="alert(1)">' },
          },
        ],
        senders: [
          {
            match: '<script>alert(1)</script>',
            feedId: "daily-news",
            title: "& < >",
          },
        ],
        error: '<script>bad</script>',
      }),
    );
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain("<script>bad</script>");
    expect(html).toContain("&lt;img src=x");
    expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
    expect(html).toContain("&amp; &lt; &gt;");
    expect(html).toContain('role="alert"');
  });

  it("shows the saved notice only after a successful save", () => {
    expect(renderManagePage(makeModel())).not.toContain(
      "Feed settings saved and applied",
    );
    expect(renderManagePage(makeModel({ saved: true }))).toContain(
      "Feed settings saved and applied",
    );
  });
});

describe("renderFeedsIndexPage: activity, filter and preview", () => {
  it("shows the last-email date and marks a quiet feed", () => {
    const html = renderFeedsIndexPage([
      makeFeed({ latestDate: "2026-10-16T08:00:00.000Z", quiet: true }),
    ]);
    expect(html).toContain("Last email Fri, 16 Oct 2026 08:00:00 GMT");
    expect(html).toContain('class="badge quiet"');
    expect(html).toContain("Quiet 7+ days");
    expect(html).toContain("All 2 retained email(s)");
  });

  it("omits the quiet badge for an active feed", () => {
    const html = renderFeedsIndexPage([makeFeed({ quiet: false })]);
    expect(html).not.toContain('class="badge quiet"');
  });

  it("renders a server-side GET filter without JavaScript", () => {
    const html = renderFeedsIndexPage([makeFeed()]);
    expect(html).toContain('<form class="filter-form" method="get" action="/rss/"');
    expect(html).toContain('<label for="feed-filter">Filter feeds</label>');
    expect(html).toContain(
      '<input id="feed-filter" type="search" name="q" value=""',
    );
    expect(html).not.toContain('class="clear-filter"');
  });

  it("reports the filtered count, keeps the query and offers a clear link", () => {
    const html = renderFeedsIndexPage([makeFeed()], {
      query: "daily",
      totalCount: 12,
    });
    expect(html).toContain("Showing 1 of 12 feed(s) matching");
    expect(html).toContain('value="daily"');
    expect(html).toContain('<a class="clear-filter" href="/rss/">Clear filter</a>');
  });

  it("renders an empty filter state and escapes the query", () => {
    const html = renderFeedsIndexPage([], {
      query: '<script>alert(1)</script>',
      totalCount: 3,
    });
    expect(html).toContain("No feed matches");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("Showing 0 of 3 feed(s)");
  });

  it("renders an escaped banner linking to the status page", () => {
    const html = renderFeedsIndexPage([makeFeed()], {
      banner: 'Ingestion is degraded: <script>bad</script> failed',
    });
    expect(html).toContain('class="banner" role="status"');
    expect(html).toContain(
      "Ingestion is degraded: &lt;script&gt;bad&lt;/script&gt; failed",
    );
    expect(html).toContain('<a href="/status">Ingestion status</a>');
    expect(html).not.toContain("<script>bad</script>");
  });

  it("renders the newest items as a preview distinct from the archive", () => {
    const html = renderFeedsIndexPage([
      makeFeed({
        preview: [
          {
            id: "22222222-2222-4222-8222-222222222222",
            subject: "Newer issue",
            date: "2026-10-16T08:00:00.000Z",
            summary: "Newer summary",
          },
          {
            id: "11111111-1111-4111-8111-111111111111",
            subject: "<b>Older</b> issue",
            date: "2026-10-15T08:00:00.000Z",
            summary: "Older & summary",
          },
        ],
      }),
    ]);
    expect(html).toContain('<p class="preview-title">Latest issues</p>');
    expect(html).toContain(
      '<a href="/view/22222222-2222-4222-8222-222222222222">Newer issue</a>',
    );
    expect(html).toContain("Newer summary");
    expect(html).toContain("&lt;b&gt;Older&lt;/b&gt; issue");
    expect(html).toContain("Older &amp; summary");
    expect(html).not.toContain("<b>Older</b>");
    expect(html).toContain("All 2 retained email(s)");
  });

  it("omits the preview block when a feed has no preview items", () => {
    const html = renderFeedsIndexPage([makeFeed()]);
    expect(html).not.toContain("Latest issues");
  });

  it("keeps visible focus styles and the copy script", () => {
    const html = renderFeedsIndexPage([makeFeed()]);
    expect(html).toContain(":focus-visible");
    expect(html).toContain(`<script>${COPY_SCRIPT}</script>`);
  });
});

describe("renderStatusPage", () => {
  function makeModel(overrides: {
    health?: Record<string, unknown>;
    serverStatus?: Record<string, unknown>;
    cron?: string;
  } = {}) {
    return {
      serverStatus: {
        started: true,
        lastSuccessfulFetchAt: "2026-11-18T11:00:00.000Z",
        lastUid: 12,
        uidvalidity: 7,
        recordCount: 42,
        idle: { enabled: true, connected: true },
        sanitizedBodyCache: { entries: 3, bytes: 2048 },
        lastError: null,
        ...overrides.serverStatus,
      },
      health: {
        status: "ok",
        staleAfterSeconds: 7200,
        quietAfterDays: 7,
        lastSuccessfulFetchAt: "2026-11-18T11:00:00.000Z",
        lastSuccessfulFetchAgeSeconds: 3600,
        idle: { enabled: true, connected: true },
        lastError: null,
        storage: {
          journalExisted: true,
          legacyJournalExisted: false,
          uidMarkerExisted: true,
          freshDataDirectory: false,
        },
        ...overrides.health,
      },
      cron: overrides.cron ?? "0 * * * *",
    };
  }

  it("renders the status fields, age and links without a script", () => {
    const html = renderStatusPage(makeModel());
    expect(html).toContain('class="badge status-ok"');
    expect(html).toContain("2026-11-18T11:00:00.000Z");
    expect(html).toContain("1 hour ago");
    expect(html).toContain("enabled, connected");
    expect(html).toContain("<dd>42</dd>");
    expect(html).toContain("UID 12 / UIDVALIDITY 7");
    expect(html).toContain("3 entries, 2048 bytes");
    expect(html).toContain("0 * * * *");
    expect(html).toContain("stale after 2 hours");
    expect(html).toContain("a feed with no email for 7 days is marked quiet");
    expect(html).toContain('<a class="back" href="/rss/">');
    expect(html).toContain('<a href="/manage">Manage feeds</a>');
    expect(html).not.toContain("<script");
    expect(html).toContain(":focus-visible");
    expect(html).not.toContain('role="alert"');
  });

  it("shows never, none and disabled states", () => {
    const html = renderStatusPage(
      makeModel({
        serverStatus: { lastSuccessfulFetchAt: null },
        health: {
          status: "starting",
          lastSuccessfulFetchAt: null,
          lastSuccessfulFetchAgeSeconds: null,
          lastError: null,
          idle: { enabled: false, connected: false },
        },
      }),
    );
    expect(html).toContain("never since startup");
    expect(html).toContain("None reported.");
    expect(html).toContain(">disabled<");
    expect(html).toContain('class="badge status-starting"');
  });

  it("escapes the last error from the fetch", () => {
    const html = renderStatusPage(
      makeModel({
        health: {
          status: "degraded",
          lastError: '<script>alert(1)</script> imap down',
          idle: { enabled: true, connected: false },
        },
      }),
    );
    expect(html).toContain('class="badge status-degraded"');
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; imap down");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("enabled, reconnecting");
  });

  it("warns about an empty data directory", () => {
    const html = renderStatusPage(
      makeModel({
        health: {
          storage: {
            journalExisted: false,
            legacyJournalExisted: false,
            uidMarkerExisted: false,
            freshDataDirectory: true,
          },
        },
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("The data directory was empty at startup");
    expect(html).toContain("<code>/data</code>");
  });
});
