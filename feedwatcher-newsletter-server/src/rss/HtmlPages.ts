import { EmailItem } from "../emails/EmailFetcher";

export interface ViewPageNavigation {
  feed?: { url: string; title: string };
  previous?: { id: string; subject: string };
  next?: { id: string; subject: string };
}

interface FeedForIndex {
  feedUrl: string;
  archiveUrl: string;
  title: string;
  senderName: string;
  senderEmail: string;
  itemCount: number;
  servedItemCount: number;
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
  .feed-card .meta a.archive { margin-left: 0.35rem; }
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
  .email-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem 1rem;
    font-size: 0.9rem;
    margin: 0 0 1rem;
  }
  .back { display: inline-block; margin-bottom: 1rem; }
  .archive-list {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
    list-style: none;
    padding: 0;
    margin: 1.5rem 0 0;
  }
  .archive-item {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
  }
  .archive-item h2 { font-size: 1.05rem; margin: 0 0 0.25rem; }
  .archive-item .meta { color: var(--text-muted); font-size: 0.85rem; margin: 0; }
  .archive-item .summary { margin: 0.5rem 0 0; }
  .manage-links { margin: -1rem 0 1.5rem; font-size: 0.9rem; }
  .manage-form fieldset {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 1rem 1.25rem;
    margin: 0 0 0.75rem;
  }
  .manage-form legend { font-weight: 600; padding: 0 0.35rem; }
  .manage-form .marker { color: var(--text-muted); font-weight: 400; }
  .manage-grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem 1rem;
    align-items: end;
  }
  @media (min-width: 640px) {
    .manage-grid { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
  .manage-field { display: grid; gap: 0.25rem; font-size: 0.85rem; }
  .manage-field span { color: var(--text-muted); }
  .manage-field input, .manage-field select {
    width: 100%;
    padding: 0.4rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface);
    color: var(--text);
    font: inherit;
  }
  .manage-feed-id {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
    color: var(--text-muted);
  }
  .manage-actions { display: flex; gap: 0.75rem; align-items: center; margin: 1rem 0 2rem; }
  button.primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: #fff;
    border-radius: 6px;
    padding: 0.55rem 1.1rem;
    font: inherit;
    cursor: pointer;
  }
  button.primary:hover { background: var(--accent-hover); }
  .notice, .error {
    border-radius: var(--radius);
    padding: 0.75rem 1rem;
    margin: 0 0 1rem;
  }
  .notice { background: #e8f5e9; border: 1px solid #a5d6a7; }
  .error { background: #fdecea; border: 1px solid #f5b5ae; }
  .manage-note { color: var(--text-muted); font-size: 0.85rem; margin: 0 0 1rem; }
`;

// Inline copy-to-clipboard script. Its exact text is hashed for the CSP, so
// keep body and policy in sync by importing this constant in both places.
export const COPY_SCRIPT = `
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

export function renderFeedsIndexPage(feeds: FeedForIndex[]): string {
  // Reader autodiscovery: one alternate link per feed. Attribute values are
  // escaped because titles come from sender names and override configuration.
  const discoveryLinks = feeds
    .map(
      (feed) =>
        `<link rel="alternate" type="application/rss+xml" title="${escapeHtml(
          feed.title,
        )}" href="${escapeHtml(feed.feedUrl)}"/>`,
    )
    .join("\n");
  const items = feeds
    .map((feed) => {
      // The feed serves a bounded window; the count says how many of the
      // retained emails it actually carries, and the archive covers the rest.
      const countText =
        feed.servedItemCount < feed.itemCount
          ? `${feed.servedItemCount} of ${feed.itemCount} email(s) in the feed`
          : `${feed.itemCount} email(s)`;
      return `
    <li class="feed-card">
      <h2>${escapeHtml(feed.title)}</h2>
      <span class="meta">${escapeHtml(feed.senderEmail)} · ${countText} · <a class="archive" href="${escapeHtml(feed.archiveUrl)}">Archive</a></span>
      <div class="feed-url">
        <code>${escapeHtml(feed.feedUrl)}</code>
        <button type="button" class="copy" data-url="${escapeHtml(feed.feedUrl)}">Copy</button>
      </div>
    </li>`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FeedWatcher Newsletter — Feeds</title>
${discoveryLinks}
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <h1>FeedWatcher Newsletter</h1>
  <p class="subtitle">${feeds.length} newsletter feed(s) available. Copy a feed URL into any RSS reader.</p>
  <p class="manage-links"><a href="/manage">Manage feeds</a></p>
  <ul class="feed-list">${items}
  </ul>
</main>
<script>${COPY_SCRIPT}</script>
</body>
</html>
`;
}

export interface FeedArchiveFeed {
  title: string;
  feedUrl: string;
  archiveUrl: string;
}

export interface FeedArchiveItem {
  id: string;
  subject: string;
  date: string;
  senderName: string;
  senderEmail: string;
  summary: string;
}

// Per-feed archive: every retained email, newest first. The RSS feed is the
// capped recent window; this page is the complete browsable record. No script,
// so the page reuses the same hash-based CSP as the index and the view.
export function renderFeedArchivePage(
  feed: FeedArchiveFeed,
  items: FeedArchiveItem[],
  servedItemCount: number,
): string {
  const listItems = items
    .map(
      (item) => `
    <li class="archive-item">
      <h2><a href="/view/${encodeURIComponent(item.id)}">${escapeHtml(
        item.subject,
      )}</a></h2>
      <p class="meta">${escapeHtml(item.senderName)} &lt;${escapeHtml(
        item.senderEmail,
      )}&gt; · ${escapeHtml(new Date(item.date).toUTCString())}</p>
      <p class="summary">${escapeHtml(item.summary)}</p>
    </li>`,
    )
    .join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FeedWatcher Newsletter — Archive: ${escapeHtml(feed.title)}</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <a class="back" href="/rss/">&larr; All feeds</a>
  <h1>${escapeHtml(feed.title)}</h1>
  <p class="subtitle">${items.length} retained email(s). The RSS feed serves the newest ${servedItemCount}. <a class="rss-feed" href="${escapeHtml(
    feed.feedUrl,
  )}">RSS feed</a></p>
  <ul class="archive-list">${listItems}
  </ul>
</main>
</body>
</html>
`;
}

// Items are listed newest-first, so "previous" is the newer neighbour and
// "next" the older one.
function renderViewNavigation(navigation: ViewPageNavigation): string {
  const links: string[] = [];
  if (navigation.feed) {
    links.push(
      `<a class="nav-feed" href="${escapeHtml(
        navigation.feed.url,
      )}">Feed: ${escapeHtml(navigation.feed.title)}</a>`,
    );
    links.push(
      `<a class="nav-archive" href="${escapeHtml(
        navigation.feed.url,
      )}/archive">Archive</a>`,
    );
  }
  if (navigation.previous) {
    links.push(
      `<a class="nav-newer" href="/view/${encodeURIComponent(
        navigation.previous.id,
      )}">&larr; Newer: ${escapeHtml(navigation.previous.subject)}</a>`,
    );
  }
  if (navigation.next) {
    links.push(
      `<a class="nav-older" href="/view/${encodeURIComponent(
        navigation.next.id,
      )}">Older: ${escapeHtml(navigation.next.subject)} &rarr;</a>`,
    );
  }
  if (links.length === 0) {
    return "";
  }
  return `  <nav class="email-nav" aria-label="Email navigation">
    ${links.join("\n    ")}
  </nav>
`;
}

export function renderViewPage(
  email: EmailItem,
  sanitizedBody: string,
  navigation: ViewPageNavigation = {},
): string {
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
${renderViewNavigation(navigation)}  <div class="email-body">${sanitizedBody}</div>
</main>
</body>
</html>
`;
}

export interface ManageFeedSettingView {
  title?: string;
  hidden?: boolean;
  maxItems?: number;
  blockRemoteImages?: boolean;
  stripTrackingPixels?: boolean;
  mergeInto?: string;
}

export interface ManageFeedRow {
  feedId: string;
  // Effective title shown when no per-feed title is configured.
  titlePlaceholder: string;
  senderEmail?: string;
  itemCount?: number;
  hidden: boolean;
  mergedInto?: string;
  setting: ManageFeedSettingView;
}

export interface ManageSenderRow {
  match: string;
  feedId?: string;
  title?: string;
}

export interface ManagePageDefaults {
  maxItems: number;
  blockRemoteImages: boolean;
  stripTrackingPixels: boolean;
}

export interface ManagePageModel {
  csrfToken: string;
  feeds: ManageFeedRow[];
  senders: ManageSenderRow[];
  defaults: ManagePageDefaults;
  saved: boolean;
  error?: string;
}

function attributeValue(value: string | undefined): string {
  return escapeHtml(value === undefined ? "" : value);
}

function triStateSelect(
  name: string,
  current: boolean | undefined,
  inheritLabel: string,
  onLabel: string,
  offLabel: string,
): string {
  const isSelected = (optionValue: string): boolean =>
    optionValue === ""
      ? current === undefined
      : current !== undefined && String(current) === optionValue;
  const options = [
    ["", inheritLabel],
    ["true", onLabel],
    ["false", offLabel],
  ]
    .map(
      ([value, label]) =>
        `<option value="${value}"${isSelected(value) ? " selected" : ""}>${escapeHtml(label)}</option>`,
    )
    .join("");
  return `<select name="${attributeValue(name)}">${options}</select>`;
}

function renderManageFeedRow(
  feed: ManageFeedRow,
  defaults: ManagePageDefaults,
): string {
  const feedId = attributeValue(feed.feedId);
  const markers: string[] = [];
  if (feed.hidden) {
    markers.push(`<span class="marker">(hidden)</span>`);
  }
  if (feed.mergedInto) {
    markers.push(
      `<span class="marker">(merged into ${escapeHtml(feed.mergedInto)})</span>`,
    );
  }
  const meta: string[] = [];
  if (feed.senderEmail) {
    meta.push(escapeHtml(feed.senderEmail));
  }
  if (feed.itemCount !== undefined) {
    meta.push(`${feed.itemCount} retained email(s)`);
  }
  return `
    <fieldset>
      <legend>${escapeHtml(feed.titlePlaceholder)} <code class="manage-feed-id">${escapeHtml(
        feed.feedId,
      )}</code> ${markers.join(" ")}</legend>
      ${meta.length > 0 ? `<p class="manage-note">${meta.join(" · ")}</p>` : ""}
      <div class="manage-grid">
        <label class="manage-field"><span>Title</span><input type="text" name="feed.${feedId}.title" value="${attributeValue(
          feed.setting.title,
        )}" placeholder="${attributeValue(feed.titlePlaceholder)}"/></label>
        <label class="manage-field"><span>Visibility</span>${triStateSelect(
          `feed.${feed.feedId}.hidden`,
          feed.setting.hidden,
          "inherit (visible)",
          "hidden",
          "visible",
        )}</label>
        <label class="manage-field"><span>Max items (0 = unlimited)</span><input type="number" min="0" step="1" name="feed.${feedId}.maxItems" value="${attributeValue(
          feed.setting.maxItems === undefined
            ? ""
            : String(feed.setting.maxItems),
        )}" placeholder="inherit (${defaults.maxItems})"/></label>
        <label class="manage-field"><span>Block remote images</span>${triStateSelect(
          `feed.${feed.feedId}.blockRemoteImages`,
          feed.setting.blockRemoteImages,
          `inherit (${defaults.blockRemoteImages ? "on" : "off"})`,
          "on",
          "off",
        )}</label>
        <label class="manage-field"><span>Strip tracking pixels</span>${triStateSelect(
          `feed.${feed.feedId}.stripTrackingPixels`,
          feed.setting.stripTrackingPixels,
          `inherit (${defaults.stripTrackingPixels ? "on" : "off"})`,
          "on",
          "off",
        )}</label>
        <label class="manage-field"><span>Merge into feed id</span><input type="text" name="feed.${feedId}.mergeInto" value="${attributeValue(
          feed.setting.mergeInto,
        )}" placeholder="none"/></label>
      </div>
    </fieldset>`;
}

function renderManageSenderRow(
  index: number,
  sender: ManageSenderRow,
): string {
  return `
        <label class="manage-field"><span>Sender match (email or name)</span><input type="text" name="sender.${index}.match" value="${attributeValue(
          sender.match,
        )}" placeholder="news@example.com"/></label>
        <label class="manage-field"><span>Feed id</span><input type="text" name="sender.${index}.feedId" value="${attributeValue(
          sender.feedId,
        )}" placeholder="none"/></label>
        <label class="manage-field"><span>Title</span><input type="text" name="sender.${index}.title" value="${attributeValue(
          sender.title,
        )}" placeholder="sender name"/></label>`;
}

// Server-rendered feed curation page. No script, no framework and no feed
// tokens or credentials: every value comes from feed ids, settings and sender
// data, and is HTML-escaped. Inherited environment defaults are shown as
// placeholders, never submitted unless the owner overrides them.
export function renderManagePage(model: ManagePageModel): string {
  const feedRows = model.feeds
    .map((feed) => renderManageFeedRow(feed, model.defaults))
    .join("\n");
  const senderRows = model.senders
    .map((sender, index) => renderManageSenderRow(index, sender))
    .join("\n");
  const notice = model.saved
    ? `  <p class="notice" role="status">Feed settings saved and applied.</p>\n`
    : "";
  const error = model.error
    ? `  <p class="error" role="alert">${escapeHtml(model.error)}</p>\n`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>FeedWatcher Newsletter — Manage feeds</title>
<style>${SHARED_CSS}</style>
</head>
<body>
<main>
  <a class="back" href="/rss/">&larr; All feeds</a>
  <h1>Manage feeds</h1>
  <p class="subtitle">Hide, rename, merge or split feeds. Settings apply immediately; the journal and feed tokens are kept.</p>
${notice}${error}  <form class="manage-form" method="post" action="/manage">
    <input type="hidden" name="csrf" value="${attributeValue(model.csrfToken)}"/>
${feedRows}
    <fieldset>
      <legend>Sender rules</legend>
      <p class="manage-note">Exact sender email or name, case-insensitive. A sender rule splits a shared feed id and wins over FEED_OVERRIDES.</p>
      <div class="manage-grid">${senderRows}
      </div>
    </fieldset>
    <div class="manage-actions">
      <button class="primary" type="submit">Save feed settings</button>
      <span class="manage-note">Privacy and item limits left on "inherit" use the environment defaults.</span>
    </div>
  </form>
</main>
</body>
</html>
`;
}
