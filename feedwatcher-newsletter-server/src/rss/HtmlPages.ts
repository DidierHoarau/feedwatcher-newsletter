import { EmailItem } from "../emails/EmailFetcher";
import { HtmlSanitizerSanitize } from "../emails/HtmlSanitizer";

interface FeedForIndex {
  feedUrl: string;
  title: string;
  senderName: string;
  senderEmail: string;
  itemCount: number;
  latestDate: string;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const SHARED_CSS = `
  :root {
    --bg: #f6f7f9;
    --surface: #ffffff;
    --text: #1a202c;
    --text-muted: #5a6472;
    --accent: #2563eb;
    --accent-hover: #1d4ed8;
    --border: #e2e6ec;
    --radius: 10px;
    --max-width: 760px;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 1.5rem;
    background: var(--bg);
    color: var(--text);
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    line-height: 1.5;
  }
  main { max-width: var(--max-width); margin: 0 auto; }
  h1 { font-size: 1.5rem; margin: 0 0 0.25rem; }
  p.subtitle { color: var(--text-muted); margin: 0 0 1.5rem; }
  .feed-list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
    list-style: none;
    padding: 0;
    margin: 0;
  }
  @media (min-width: 640px) {
    body { padding: 2.5rem 1.5rem; }
    h1 { font-size: 1.75rem; }
  }
  .feed-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.25rem 1rem;
    align-items: center;
  }
  .feed-card h2 { font-size: 1.05rem; margin: 0; }
  .feed-card .meta { color: var(--text-muted); font-size: 0.85rem; grid-column: 1; }
  .feed-url {
    grid-column: 1 / -1;
    display: flex;
    gap: 0.5rem;
    align-items: stretch;
    margin-top: 0.35rem;
  }
  .feed-url code {
    flex: 1;
    min-width: 0;
    overflow-wrap: anywhere;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 0.4rem 0.6rem;
    font-size: 0.8rem;
  }
  button.copy {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    border-radius: 6px;
    padding: 0.4rem 0.75rem;
    font-size: 0.8rem;
    cursor: pointer;
  }
  button.copy:hover { background: var(--accent-hover); }
  a { color: var(--accent); }
  .email-meta { color: var(--text-muted); font-size: 0.9rem; margin: 0 0 1.5rem; }
  .email-body {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1.25rem;
    overflow-wrap: anywhere;
  }
  .email-body img { max-width: 100%; height: auto; }
  .back { display: inline-block; margin-bottom: 1rem; }
`;

function copyScript(): string {
  return `
  document.querySelectorAll("button.copy[data-url]").forEach(function (button) {
    button.addEventListener("click", function () {
      navigator.clipboard.writeText(button.getAttribute("data-url") || "").then(function () {
        var original = button.textContent;
        button.textContent = "Copied!";
        setTimeout(function () { button.textContent = original; }, 1500);
      });
    });
  });
`;
}

export function renderFeedsIndexPage(feeds: FeedForIndex[]): string {
  const items = feeds
    .map(
      (feed) => `
    <li class="feed-card">
      <h2>${escapeHtml(feed.title)}</h2>
      <span class="meta">${escapeHtml(feed.senderEmail)} · ${feed.itemCount} email(s)</span>
      <div class="feed-url">
        <code>${escapeHtml(feed.feedUrl)}</code>
        <button type="button" class="copy" data-url="${escapeHtml(feed.feedUrl)}">Copy</button>
      </div>
    </li>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FeedWatcher Newsletter — Feeds</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <h1>FeedWatcher Newsletter</h1>
  <p class="subtitle">${feeds.length} newsletter feed(s) available. Copy a feed URL into any RSS reader.</p>
  <ul class="feed-list">${items}
  </ul>
</main>
<script>${copyScript()}</script>
</body>
</html>
`;
}

export function renderViewPage(email: EmailItem): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${escapeHtml(email.subject)}</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <a class="back" href="/rss/">&larr; All feeds</a>
  <h1>${escapeHtml(email.subject)}</h1>
  <p class="email-meta">${escapeHtml(email.senderName)} &lt;${escapeHtml(
    email.senderEmail,
  )}&gt; · ${escapeHtml(new Date(email.dateReceived).toUTCString())}</p>
  <div class="email-body">${HtmlSanitizerSanitize(email.body)}</div>
</main>
</body>
</html>
`;
}
