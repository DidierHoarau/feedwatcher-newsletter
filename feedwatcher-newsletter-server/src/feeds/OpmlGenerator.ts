function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// OPML 2.0 document listing one outline per feed under a Newsletters folder,
// compatible with the OPML import of FeedWatcher and most RSS readers. The
// caller supplies the creation date so the document (and its ETag) is stable
// between requests. Outlines are sorted here so the document is deterministic
// regardless of the caller's order; feedId is the stable key behind xmlUrl,
// which rotates when a private token rotates.
export function OpmlGeneratorBuild(
  title: string,
  siteUrl: string,
  feeds: { feedId: string; title: string; feedUrl: string }[],
  dateCreated: Date,
): string {
  const outlines = feeds
    .slice()
    .sort(
      (a, b) =>
        a.title.localeCompare(b.title) || a.feedId.localeCompare(b.feedId),
    )
    .map(
      (feed) =>
        `      <outline type="rss" text="${xmlEscape(feed.title)}" title="${xmlEscape(
          feed.title,
        )}" xmlUrl="${xmlEscape(feed.feedUrl)}" htmlUrl="${xmlEscape(siteUrl)}"/>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>${xmlEscape(title)}</title>
    <dateCreated>${dateCreated.toUTCString()}</dateCreated>
  </head>
  <body>
    <outline text="Newsletters" title="Newsletters">
${outlines}
    </outline>
  </body>
</opml>
`;
}
