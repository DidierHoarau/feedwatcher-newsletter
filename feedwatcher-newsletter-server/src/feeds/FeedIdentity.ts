import { createHash, randomBytes, timingSafeEqual } from "crypto";
import * as fse from "fs-extra";
import path from "path";
import { OTelLogger } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("FeedIdentity");

export interface FeedOverride {
  feedId?: string;
  title?: string;
}

interface FeedIdentityOptions {
  ignoreList: string;
  overrides: Record<string, FeedOverride>;
  privateUrls: boolean;
  privateUrlsStrict?: boolean;
  dataDir: string;
}

// Feed ids reach URLs and file contents, so they are restricted to lowercase
// ASCII: a dot would break the `<feedId>.<token>` format, and a slash or an
// empty id produces an unreachable feed.
const FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

let ignoreTerms: string[] = [];
let overrides: Record<string, FeedOverride> = {};
let privateUrls = false;
let privateUrlsStrict = false;
let tokensFilePath = "";
let tokens: Record<string, string> = {};
// Set when the in-memory map changed without a successful persist (a failed
// write, or a token created defensively on a request path). The next ensure
// pass retries instead of considering the map saved.
let tokensDirty = false;
let generation = 0;

// Drop overrides whose feedId cannot be used in a URL. The rest of the entry
// (notably its title) is kept, and the derived id is used instead. Called on
// every init, so a hot reload is sanitized exactly like the initial config.
function sanitizeOverrides(
  configured: Record<string, FeedOverride>,
): Record<string, FeedOverride> {
  const sanitized: Record<string, FeedOverride> = {};
  for (const [sender, value] of Object.entries(configured)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      logger.warn(
        `Ignoring FEED_OVERRIDES entry "${sender}": the value must be an object with an optional feedId and title`,
      );
      continue;
    }
    const entry: FeedOverride = {};
    if (value.title !== undefined) {
      entry.title = value.title;
    }
    if (value.feedId !== undefined) {
      if (
        typeof value.feedId === "string" &&
        FEED_ID_PATTERN.test(value.feedId)
      ) {
        entry.feedId = value.feedId;
      } else {
        logger.warn(
          `Ignoring invalid FEED_OVERRIDES feedId "${String(value.feedId)}" for "${sender}": it must match ${String(FEED_ID_PATTERN)}; the derived feed id will be used`,
        );
      }
    }
    sanitized[sender] = entry;
  }
  return sanitized;
}

export function FeedIdentityInit(options: FeedIdentityOptions): void {
  ignoreTerms = options.ignoreList
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
  overrides = sanitizeOverrides(options.overrides || {});
  privateUrls = options.privateUrls;
  privateUrlsStrict = options.privateUrlsStrict === true;
  const nextTokensFilePath = path.join(options.dataDir, "feed-tokens.json");
  // Keep in-memory tokens across a reload of the same data directory: a token
  // created defensively on a request path must not be rotated before the next
  // ensure pass persists it. A new data directory (tests) starts from disk.
  tokens =
    nextTokensFilePath === tokensFilePath
      ? { ...readTokens(nextTokensFilePath), ...tokens }
      : readTokens(nextTokensFilePath);
  if (nextTokensFilePath !== tokensFilePath) {
    tokensDirty = false;
  }
  tokensFilePath = nextTokensFilePath;
  generation++;
  logger.info(
    `Feed identity: ${ignoreTerms.length} ignored sender term(s), ${
      Object.keys(overrides).length
    } override(s), private URLs ${privateUrls ? "enabled" : "disabled"}${
      privateUrls && privateUrlsStrict ? " (strict: bare ids rejected)" : ""
    }`,
  );
}

// Monotonic configuration version: derived data (the in-memory feed index)
// rebuilds when it changes, so a hot reload of the ignore list or overrides
// takes effect without a write.
export function FeedIdentityGetGeneration(): number {
  return generation;
}

function readTokens(filePath = tokensFilePath): Record<string, string> {
  try {
    if (fse.existsSync(filePath)) {
      return fse.readJsonSync(filePath);
    }
  } catch (err) {
    logger.error(`Failed to load feed tokens from ${filePath}`, err as Error);
  }
  return {};
}

// Atomic replace (tmp + fsync + rename), same protocol as the UID marker: a
// crash or a failed write never leaves a truncated feed-tokens.json, and the
// previous file stays intact.
function writeTokens(): void {
  const tmpPath = `${tokensFilePath}.tmp`;
  try {
    fse.ensureDirSync(path.dirname(tokensFilePath));
    const fd = fse.openSync(tmpPath, "w");
    try {
      fse.writeSync(fd, JSON.stringify(tokens, null, 2));
      fse.fsyncSync(fd);
    } finally {
      fse.closeSync(fd);
    }
    fse.renameSync(tmpPath, tokensFilePath);
    tokensDirty = false;
  } catch (err) {
    try {
      fse.unlinkSync(tmpPath);
    } catch {
      // The temp file may not exist; nothing to clean up.
    }
    logger.error(
      `Failed to save feed tokens to ${tokensFilePath}`,
      err as Error,
    );
  }
}

function findOverride(
  senderName: string,
  senderEmail: string,
): FeedOverride | undefined {
  const email = (senderEmail || "").toLowerCase();
  if (email && overrides[email]) {
    return overrides[email];
  }
  const name = (senderName || "").toLowerCase();
  if (name && overrides[name]) {
    return overrides[name];
  }
  return undefined;
}

// A sender is ignored when any configured term appears (case-insensitive) in
// its name or email address.
export function FeedIdentityIsSenderIgnored(
  senderName: string,
  senderEmail: string,
): boolean {
  const haystack = `${senderName} ${senderEmail}`.toLowerCase();
  return ignoreTerms.some((term) => haystack.includes(term));
}

// Latin sender names keep their historical id, so existing subscriptions stay
// stable. Names that contain no ASCII alphanumeric character (Cyrillic, CJK,
// Arabic, emoji-only, ...) would otherwise normalize to an empty, unreachable
// id: they fall back to a deterministic hash of the trimmed, lowercased name.
function deriveFeedId(senderName: string): string {
  const normalized = (senderName || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 64);
  if (normalized.length > 0) {
    return normalized;
  }
  const hash = createHash("sha1")
    .update((senderName || "").trim().toLowerCase())
    .digest("hex")
    .slice(0, 8);
  return `sender-${hash}`;
}

// Feed id: configured override feedId when the sender matches one, otherwise
// derived from the sender name (lowercased, non-alphanumerics removed).
export function FeedIdentityGetFeedId(
  senderName: string,
  senderEmail: string,
): string {
  const override = findOverride(senderName, senderEmail);
  if (override && override.feedId) {
    return override.feedId;
  }
  return deriveFeedId(senderName);
}

// Feed title: the override title of the feed when one is configured,
// otherwise the sender name it was derived from.
export function FeedIdentityGetTitle(
  senderName: string,
  senderEmail: string,
): string {
  const override = findOverride(senderName, senderEmail);
  if (override && override.title) {
    return override.title;
  }
  return senderName;
}

// Stable unguessable token per feed, persisted so tokens survive restarts.
// Listing requests must never write: a missing token is generated in memory
// and persisted by the next FeedIdentityEnsureTokens pass.
export function FeedIdentityGetFeedToken(feedId: string): string {
  const existing = tokens[feedId];
  if (typeof existing === "string" && existing.length > 0) {
    return existing;
  }
  const token = randomBytes(12).toString("hex");
  tokens[feedId] = token;
  tokensDirty = true;
  logger.warn(
    `Feed token for feed ${feedId} was missing outside an ensure pass; it will be persisted on the next index build`,
  );
  return token;
}

// Create every missing token in memory and persist the file at most once per
// pass. Called after startup and after each fetch/index rebuild so listing
// requests never touch the filesystem.
export function FeedIdentityEnsureTokens(feedIds: Iterable<string>): void {
  if (!privateUrls) {
    return;
  }
  let created = 0;
  for (const feedId of feedIds) {
    if (!feedId) continue;
    const existing = tokens[feedId];
    if (typeof existing === "string" && existing.length > 0) {
      continue;
    }
    tokens[feedId] = randomBytes(12).toString("hex");
    tokensDirty = true;
    created++;
  }
  if (tokensDirty) {
    writeTokens();
  }
  if (created > 0) {
    logger.info(`Created ${created} feed token(s)`);
  }
}

// The id to advertise in lists, OPML and feed URLs: `<feedId>.<token>` when
// private URLs are enabled, the bare feed id otherwise.
export function FeedIdentityGetFeedUrlId(feedId: string): string {
  if (!privateUrls) {
    return feedId;
  }
  return `${feedId}.${FeedIdentityGetFeedToken(feedId)}`;
}

// Resolve an id coming from a feed URL: `<feedId>.<token>` or a bare feed id.
// Resolution never creates a token: a dotted id is only valid when it matches
// a persisted token, so probing random ids cannot grow feed-tokens.json.
// Bare ids stay valid for existing subscriptions unless strict private mode
// is enabled.
export function FeedIdentityResolveFeedUrlId(
  urlId: string,
): { feedId: string; valid: boolean } {
  const dotIndex = urlId.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === urlId.length - 1) {
    return { feedId: urlId, valid: !(privateUrls && privateUrlsStrict) };
  }
  const feedId = urlId.slice(0, dotIndex);
  const token = urlId.slice(dotIndex + 1);
  if (!privateUrls) {
    return { feedId, valid: true };
  }
  return { feedId, valid: tokenEquals(tokens[feedId], token) };
}

// Constant-time token comparison: hash both sides first so the comparison is
// independent of the input lengths. The typeof guard rejects inherited object
// properties (feed ids are unvalidated URL input, e.g. "constructor").
function tokenEquals(expected: string | undefined, provided: string): boolean {
  if (typeof expected !== "string" || expected.length === 0) {
    return false;
  }
  const expectedDigest = createHash("sha256").update(expected).digest();
  const providedDigest = createHash("sha256").update(provided).digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

// Delete tokens of feeds that no longer exist. Called at startup so probes and
// disappeared senders do not accumulate entries; tokens of existing feeds are
// preserved and the file is only rewritten when something changed.
export function FeedIdentityPruneTokens(feedIds: Iterable<string>): void {
  const keep = new Set(feedIds);
  let removed = 0;
  for (const feedId of Object.keys(tokens)) {
    if (!keep.has(feedId)) {
      delete tokens[feedId];
      removed++;
    }
  }
  if (removed > 0) {
    writeTokens();
    logger.info(
      `Pruned ${removed} feed token(s) for feeds that no longer exist`,
    );
  }
}
