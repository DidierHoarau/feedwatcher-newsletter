function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// OPML 2.0 document listing one outline per feed, compatible with the OPML
// import of FeedWatcher and most RSS readers. The caller supplies the
// creation date so the document (and its ETag) is stable between requests.
export function OpmlGeneratorBuild(
  title: string,
  siteUrl: string,
  feeds: { title: string; feedUrl: string }[],
  dateCreated: Date,
): string {
  const outlines = feeds
    .map(
      (feed) =>
        `    <outline type="rss" text="${xmlEscape(feed.title)}" title="${xmlEscape(
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
${outlines}
  </body>
</opml>
`;
}
