function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// OPML 2.0 document listing one outline per feed, compatible with the OPML
// import of FeedWatcher and most RSS readers.
export function OpmlGeneratorBuild(
  title: string,
  siteUrl: string,
  feeds: { title: string; feedUrl: string }[],
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
    <dateCreated>${new Date().toUTCString()}</dateCreated>
  </head>
  <body>
${outlines}
  </body>
</opml>
`;
}
