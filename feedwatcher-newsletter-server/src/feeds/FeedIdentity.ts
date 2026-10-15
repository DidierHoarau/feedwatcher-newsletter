import { randomBytes } from "crypto";
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
  dataDir: string;
}

let ignoreTerms: string[] = [];
let overrides: Record<string, FeedOverride> = {};
let privateUrls = false;
let tokensFilePath = "";
let tokens: Record<string, string> = {};

export function FeedIdentityInit(options: FeedIdentityOptions): void {
  ignoreTerms = options.ignoreList
    .split(",")
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length > 0);
  overrides = options.overrides || {};
  privateUrls = options.privateUrls;
  tokensFilePath = path.join(options.dataDir, "feed-tokens.json");
  tokens = readTokens();
  logger.info(
    `Feed identity: ${ignoreTerms.length} ignored sender term(s), ${
      Object.keys(overrides).length
    } override(s), private URLs ${privateUrls ? "enabled" : "disabled"}`,
  );
}

function readTokens(): Record<string, string> {
  try {
    if (fse.existsSync(tokensFilePath)) {
      return fse.readJsonSync(tokensFilePath);
    }
  } catch (err) {
    logger.error(
      `Failed to load feed tokens from ${tokensFilePath}`,
      err as Error,
    );
  }
  return {};
}

function writeTokens(): void {
  try {
    fse.ensureDirSync(path.dirname(tokensFilePath));
    fse.writeJsonSync(tokensFilePath, tokens, { spaces: 2 });
  } catch (err) {
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
  return senderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 64);
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
export function FeedIdentityGetFeedToken(feedId: string): string {
  if (tokens[feedId]) {
    return tokens[feedId];
  }
  const token = randomBytes(12).toString("hex");
  tokens[feedId] = token;
  writeTokens();
  return token;
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
// The token must match the persisted one when present; bare ids always
// resolve so existing reader subscriptions keep working.
export function FeedIdentityResolveFeedUrlId(
  urlId: string,
): { feedId: string; valid: boolean } {
  const dotIndex = urlId.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === urlId.length - 1) {
    return { feedId: urlId, valid: true };
  }
  const feedId = urlId.slice(0, dotIndex);
  const token = urlId.slice(dotIndex + 1);
  if (!privateUrls) {
    return { feedId, valid: true };
  }
  return { feedId, valid: FeedIdentityGetFeedToken(feedId) === token };
}
