import * as fse from "fs-extra";
import path from "path";
import { OTelLogger } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("FeedSettings");

// Feed ids reach URLs and file contents, so they are restricted to lowercase
// ASCII: a dot would break the `<feedId>.<token>` format, and a slash or an
// empty id produces an unreachable feed. Single source of truth shared with
// FeedIdentity.
export const FEED_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const FEED_SETTINGS_VERSION = 1;
export const FEED_SETTINGS_FILE_NAME = "feed-settings.json";

const MAX_TITLE_LENGTH = 200;
const MAX_SENDER_KEY_LENGTH = 320;
const MAX_MERGE_DEPTH = 16;
const MAX_FILE_BYTES = 1024 * 1024;

export interface FeedSetting {
  title?: string;
  hidden?: boolean;
  maxItems?: number;
  blockRemoteImages?: boolean;
  stripTrackingPixels?: boolean;
  mergeInto?: string;
}

export interface SenderRule {
  feedId?: string;
  title?: string;
}

export interface FeedSettingsDocument {
  version: number;
  feeds: Record<string, FeedSetting>;
  senders: Record<string, SenderRule>;
}

// Strict write validation reports every problem with a field path, so the API
// and the management form can point at the offending row.
export class FeedSettingsValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`Invalid feed settings: ${errors.join("; ")}`);
    this.name = "FeedSettingsValidationError";
  }
}

let filePath = "";
let settings: FeedSettingsDocument = emptySettings();
// Increments only when the normalized content actually changes: the in-memory
// feed index rebuilds from it, so loading an identical file is a no-op.
let generation = 0;

function emptySettings(): FeedSettingsDocument {
  return {
    version: FEED_SETTINGS_VERSION,
    feeds: Object.create(null) as Record<string, FeedSetting>,
    senders: Object.create(null) as Record<string, SenderRule>,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value)
  );
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeTitle(value: string): string {
  return value
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const result = Object.create(null) as Record<string, T>;
  for (const [key, value] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
    result[key] = value;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Strict validation (write path)
// ---------------------------------------------------------------------------

function validateMergeGraph(feeds: Record<string, FeedSetting>, errors: string[]): void {
  const reported = new Set<string>();
  for (const [feedId, entry] of Object.entries(feeds)) {
    let current = entry.mergeInto;
    if (!current) continue;
    const visited = new Set<string>([feedId]);
    let depth = 0;
    while (current) {
      depth++;
      if (depth > MAX_MERGE_DEPTH) {
        const field = `feeds.${feedId}.mergeInto`;
        if (!reported.has(field)) {
          errors.push(`${field}: merge chain exceeds ${MAX_MERGE_DEPTH} links`);
          reported.add(field);
        }
        break;
      }
      if (visited.has(current)) {
        const field = `feeds.${feedId}.mergeInto`;
        if (!reported.has(field)) {
          errors.push(`${field}: merge cycle through "${current}"`);
          reported.add(field);
        }
        break;
      }
      visited.add(current);
      current = feeds[current]?.mergeInto;
    }
  }
}

function validateDocument(raw: unknown): FeedSettingsDocument {
  const errors: string[] = [];
  if (!isPlainObject(raw)) {
    throw new FeedSettingsValidationError(["document: must be a JSON object"]);
  }
  const version = raw.version;
  if (version !== undefined && version !== FEED_SETTINGS_VERSION) {
    errors.push(`version: must be ${FEED_SETTINGS_VERSION}`);
  }

  const feeds = Object.create(null) as Record<string, FeedSetting>;
  const feedsRaw = raw.feeds;
  if (feedsRaw !== undefined) {
    if (!isPlainObject(feedsRaw)) {
      errors.push("feeds: must be an object");
    } else {
      for (const [feedId, value] of Object.entries(feedsRaw)) {
        const field = `feeds.${feedId}`;
        if (!FEED_ID_PATTERN.test(feedId)) {
          errors.push(`${field}: invalid feed id`);
          continue;
        }
        if (!isPlainObject(value)) {
          errors.push(`${field}: must be an object`);
          continue;
        }
        const entry: FeedSetting = {};
        if (value.title !== undefined) {
          if (typeof value.title !== "string") {
            errors.push(`${field}.title: must be a string`);
          } else {
            const title = normalizeTitle(value.title);
            if (title.length > MAX_TITLE_LENGTH) {
              errors.push(`${field}.title: must be at most ${MAX_TITLE_LENGTH} characters`);
            } else if (title.length > 0) {
              entry.title = title;
            }
          }
        }
        for (const flag of [
          "hidden",
          "blockRemoteImages",
          "stripTrackingPixels",
        ] as const) {
          if (value[flag] !== undefined) {
            if (typeof value[flag] !== "boolean") {
              errors.push(`${field}.${flag}: must be a boolean`);
            } else {
              entry[flag] = value[flag];
            }
          }
        }
        if (value.maxItems !== undefined) {
          if (
            typeof value.maxItems !== "number" ||
            !Number.isSafeInteger(value.maxItems) ||
            value.maxItems < 0
          ) {
            errors.push(`${field}.maxItems: must be a non-negative integer`);
          } else {
            entry.maxItems = value.maxItems;
          }
        }
        if (value.mergeInto !== undefined) {
          if (
            typeof value.mergeInto !== "string" ||
            !FEED_ID_PATTERN.test(value.mergeInto)
          ) {
            errors.push(`${field}.mergeInto: must be a valid feed id`);
          } else if (value.mergeInto === feedId) {
            errors.push(`${field}.mergeInto: a feed cannot merge into itself`);
          } else {
            entry.mergeInto = value.mergeInto;
          }
        }
        feeds[feedId] = entry;
      }
    }
  }

  const senders = Object.create(null) as Record<string, SenderRule>;
  const sendersRaw = raw.senders;
  if (sendersRaw !== undefined) {
    if (!isPlainObject(sendersRaw)) {
      errors.push("senders: must be an object");
    } else {
      const seen = new Set<string>();
      for (const [rawKey, value] of Object.entries(sendersRaw)) {
        const key = rawKey.trim().toLowerCase();
        const field = `senders.${rawKey}`;
        if (key.length === 0) {
          errors.push(`${field}: sender match must not be empty`);
          continue;
        }
        if (key.length > MAX_SENDER_KEY_LENGTH) {
          errors.push(`${field}: sender match must be at most ${MAX_SENDER_KEY_LENGTH} characters`);
          continue;
        }
        if (seen.has(key)) {
          errors.push(`${field}: duplicate sender match "${key}"`);
          continue;
        }
        seen.add(key);
        if (!isPlainObject(value)) {
          errors.push(`${field}: must be an object`);
          continue;
        }
        const entry: SenderRule = {};
        if (value.feedId !== undefined) {
          if (
            typeof value.feedId !== "string" ||
            !FEED_ID_PATTERN.test(value.feedId)
          ) {
            errors.push(`${field}.feedId: must be a valid feed id`);
          } else {
            entry.feedId = value.feedId;
          }
        }
        if (value.title !== undefined) {
          if (typeof value.title !== "string") {
            errors.push(`${field}.title: must be a string`);
          } else {
            const title = normalizeTitle(value.title);
            if (title.length > MAX_TITLE_LENGTH) {
              errors.push(`${field}.title: must be at most ${MAX_TITLE_LENGTH} characters`);
            } else if (title.length > 0) {
              entry.title = title;
            }
          }
        }
        senders[key] = entry;
      }
    }
  }

  validateMergeGraph(feeds, errors);

  if (errors.length > 0) {
    throw new FeedSettingsValidationError(errors);
  }
  return {
    version: FEED_SETTINGS_VERSION,
    feeds: sortedRecord(Object.entries(feeds)),
    senders: sortedRecord(Object.entries(senders)),
  };
}

// ---------------------------------------------------------------------------
// Lenient read path: invalid entries and fields are dropped with a warning so
// a hand-edited file never prevents the service from starting.
// ---------------------------------------------------------------------------

function sanitizeDocument(raw: unknown): FeedSettingsDocument | undefined {
  if (!isPlainObject(raw)) {
    logger.warn("Ignoring feed settings: the document must be a JSON object");
    return undefined;
  }
  if (raw.version !== undefined && raw.version !== FEED_SETTINGS_VERSION) {
    logger.warn(
      `Ignoring feed settings: unsupported version ${String(raw.version)} (expected ${FEED_SETTINGS_VERSION})`,
    );
    return undefined;
  }

  const feeds = Object.create(null) as Record<string, FeedSetting>;
  const feedsRaw = raw.feeds;
  if (feedsRaw !== undefined && !isPlainObject(feedsRaw)) {
    logger.warn("Ignoring feed settings feeds: the value must be an object");
  } else if (isPlainObject(feedsRaw)) {
    for (const [feedId, value] of Object.entries(feedsRaw)) {
      if (!FEED_ID_PATTERN.test(feedId)) {
        logger.warn(
          `Ignoring feed settings entry "${feedId}": the feed id is invalid`,
        );
        continue;
      }
      if (!isPlainObject(value)) {
        logger.warn(
          `Ignoring feed settings entry "${feedId}": the value must be an object`,
        );
        continue;
      }
      const entry: FeedSetting = {};
      if (value.title !== undefined) {
        if (typeof value.title === "string") {
          const title = normalizeTitle(value.title);
          if (title.length <= MAX_TITLE_LENGTH && title.length > 0) {
            entry.title = title;
          } else {
            logger.warn(
              `Ignoring feed settings title for "${feedId}": it must be 1-${MAX_TITLE_LENGTH} characters`,
            );
          }
        } else {
          logger.warn(
            `Ignoring feed settings title for "${feedId}": it must be a string`,
          );
        }
      }
      for (const flag of [
        "hidden",
        "blockRemoteImages",
        "stripTrackingPixels",
      ] as const) {
        if (value[flag] !== undefined) {
          if (typeof value[flag] === "boolean") {
            entry[flag] = value[flag];
          } else {
            logger.warn(
              `Ignoring feed settings ${flag} for "${feedId}": it must be a boolean`,
            );
          }
        }
      }
      if (value.maxItems !== undefined) {
        if (
          typeof value.maxItems === "number" &&
          Number.isSafeInteger(value.maxItems) &&
          value.maxItems >= 0
        ) {
          entry.maxItems = value.maxItems;
        } else {
          logger.warn(
            `Ignoring feed settings maxItems for "${feedId}": it must be a non-negative integer`,
          );
        }
      }
      if (value.mergeInto !== undefined) {
        if (
          typeof value.mergeInto === "string" &&
          FEED_ID_PATTERN.test(value.mergeInto) &&
          value.mergeInto !== feedId
        ) {
          entry.mergeInto = value.mergeInto;
        } else {
          logger.warn(
            `Ignoring feed settings mergeInto for "${feedId}": it must be a different valid feed id`,
          );
        }
      }
      feeds[feedId] = entry;
    }
  }

  // Drop merge edges that would loop (self-merges were already rejected above).
  for (const [feedId, entry] of Object.entries(feeds)) {
    if (!entry.mergeInto) continue;
    const visited = new Set<string>([feedId]);
    let current: string | undefined = entry.mergeInto;
    let depth = 0;
    while (current) {
      depth++;
      if (depth > MAX_MERGE_DEPTH || visited.has(current)) {
        logger.warn(
          `Ignoring feed settings mergeInto for "${feedId}": the merge chain loops or is too deep`,
        );
        delete entry.mergeInto;
        break;
      }
      visited.add(current);
      current = feeds[current]?.mergeInto;
    }
  }

  const senders = Object.create(null) as Record<string, SenderRule>;
  const sendersRaw = raw.senders;
  if (sendersRaw !== undefined && !isPlainObject(sendersRaw)) {
    logger.warn("Ignoring feed settings senders: the value must be an object");
  } else if (isPlainObject(sendersRaw)) {
    for (const [rawKey, value] of Object.entries(sendersRaw)) {
      const key = rawKey.trim().toLowerCase();
      if (key.length === 0 || key.length > MAX_SENDER_KEY_LENGTH) {
        logger.warn(
          `Ignoring feed settings sender rule "${rawKey}": the match must be 1-${MAX_SENDER_KEY_LENGTH} characters`,
        );
        continue;
      }
      if (hasOwn(senders, key)) {
        logger.warn(
          `Ignoring feed settings sender rule "${rawKey}": it duplicates "${key}"`,
        );
        continue;
      }
      if (!isPlainObject(value)) {
        logger.warn(
          `Ignoring feed settings sender rule "${rawKey}": the value must be an object`,
        );
        continue;
      }
      const entry: SenderRule = {};
      if (value.feedId !== undefined) {
        if (
          typeof value.feedId === "string" &&
          FEED_ID_PATTERN.test(value.feedId)
        ) {
          entry.feedId = value.feedId;
        } else {
          logger.warn(
            `Ignoring feed settings sender feedId for "${rawKey}": it must be a valid feed id`,
          );
        }
      }
      if (value.title !== undefined) {
        if (typeof value.title === "string") {
          const title = normalizeTitle(value.title);
          if (title.length <= MAX_TITLE_LENGTH && title.length > 0) {
            entry.title = title;
          } else {
            logger.warn(
              `Ignoring feed settings sender title for "${rawKey}": it must be 1-${MAX_TITLE_LENGTH} characters`,
            );
          }
        } else {
          logger.warn(
            `Ignoring feed settings sender title for "${rawKey}": it must be a string`,
          );
        }
      }
      if (entry.feedId !== undefined || entry.title !== undefined) {
        senders[key] = entry;
      }
    }
  }

  return {
    version: FEED_SETTINGS_VERSION,
    feeds: sortedRecord(Object.entries(feeds)),
    senders: sortedRecord(Object.entries(senders)),
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type ReadResult =
  | { status: "ok"; document: FeedSettingsDocument }
  | { status: "missing" }
  | { status: "invalid"; reason: string };

function readDocumentFromDisk(): ReadResult {
  try {
    if (!fse.existsSync(filePath)) {
      return { status: "missing" };
    }
    const stats = fse.statSync(filePath);
    if (stats.size > MAX_FILE_BYTES) {
      return {
        status: "invalid",
        reason: `the file exceeds ${MAX_FILE_BYTES} bytes`,
      };
    }
    const text = fse.readFileSync(filePath, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { status: "invalid", reason: "invalid JSON" };
    }
    const document = sanitizeDocument(parsed);
    if (!document) {
      return { status: "invalid", reason: "unsupported document" };
    }
    return { status: "ok", document };
  } catch (err) {
    return { status: "invalid", reason: (err as Error).message };
  }
}

// Atomic replace (tmp + fsync + rename), same protocol as feed-tokens.json: a
// crash or a failed write never leaves a truncated settings file.
function writeDocument(document: FeedSettingsDocument): void {
  const tmpPath = `${filePath}.tmp`;
  try {
    fse.ensureDirSync(path.dirname(filePath));
    const fd = fse.openSync(tmpPath, "w");
    try {
      fse.writeSync(fd, JSON.stringify(document, null, 2));
      fse.fsyncSync(fd);
    } finally {
      fse.closeSync(fd);
    }
    fse.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fse.unlinkSync(tmpPath);
    } catch {
      // The temp file may not exist; nothing to clean up.
    }
    logger.error(`Failed to save feed settings to ${filePath}`, err as Error);
    throw err;
  }
}

// Apply a normalized document; returns true when it differs from the current
// state (and therefore bumped the generation).
function applyDocument(next: FeedSettingsDocument): boolean {
  const previous = JSON.stringify(settings);
  const serialized = JSON.stringify(next);
  if (previous === serialized) {
    return false;
  }
  settings = next;
  generation++;
  return true;
}

export function FeedSettingsGetFilePath(): string {
  return filePath;
}

export function FeedSettingsInit(dataDir: string): void {
  const nextPath = path.join(dataDir, FEED_SETTINGS_FILE_NAME);
  const sameFile = nextPath === filePath;
  if (!sameFile) {
    filePath = nextPath;
    settings = emptySettings();
  }
  const result = readDocumentFromDisk();
  let next: FeedSettingsDocument;
  if (result.status === "ok") {
    next = result.document;
  } else if (result.status === "missing") {
    next = emptySettings();
  } else {
    if (!sameFile) {
      settings = emptySettings();
    }
    logger.warn(
      `Ignoring feed settings ${filePath}: ${result.reason}; keeping the ${
        sameFile ? "previous settings" : "empty settings"
      }`,
    );
    return;
  }
  applyDocument(next);
  logger.info(
    `Feed settings: ${Object.keys(settings.feeds).length} feed(s), ${
      Object.keys(settings.senders).length
    } sender rule(s) from ${filePath}`,
  );
}

// Re-read the file. Returns true when the file was accepted (applied or
// identical to the current settings) and false when it is unreadable or
// invalid, in which case the previous settings stay active. A missing file
// resets to empty (removing curation is intentional).
export function FeedSettingsReload(): boolean {
  const result = readDocumentFromDisk();
  if (result.status === "invalid") {
    logger.warn(
      `Ignoring feed settings reload: ${filePath} is ${result.reason}; keeping the previous settings`,
    );
    return false;
  }
  const next = result.status === "ok" ? result.document : emptySettings();
  const changed = applyDocument(next);
  if (changed) {
    logger.info(`Feed settings reloaded from ${filePath}`);
  }
  return true;
}

// Strict full-document replace. The file is written first: a failed write
// leaves both the file and the in-memory settings untouched.
export function FeedSettingsSave(raw: unknown): void {
  const document = validateDocument(raw);
  writeDocument(document);
  applyDocument(document);
}

export function FeedSettingsGet(): FeedSettingsDocument {
  return JSON.parse(JSON.stringify(settings)) as FeedSettingsDocument;
}

export function FeedSettingsGetGeneration(): number {
  return generation;
}

export function FeedSettingsGetForFeed(feedId: string): FeedSetting | undefined {
  const entry = settings.feeds[feedId];
  return entry ? { ...entry } : undefined;
}

export function FeedSettingsIsHidden(feedId: string): boolean {
  return settings.feeds[feedId]?.hidden === true;
}

export function FeedSettingsGetMaxItems(
  feedId: string,
  fallback: number,
): number {
  const value = settings.feeds[feedId]?.maxItems;
  return value === undefined ? fallback : value;
}

export function FeedSettingsGetStripTrackingPixels(
  feedId: string,
  fallback: boolean,
): boolean {
  const value = settings.feeds[feedId]?.stripTrackingPixels;
  return value === undefined ? fallback : value;
}

export function FeedSettingsGetBlockRemoteImages(
  feedId: string,
  fallback: boolean,
): boolean {
  const value = settings.feeds[feedId]?.blockRemoteImages;
  return value === undefined ? fallback : value;
}

// Resolve the final feed id of a merge chain. Self-merges and cycles are
// rejected on write and sanitized on read; the depth guard is a last resort.
export function FeedSettingsResolveMergeTarget(feedId: string): string {
  let current = feedId;
  const visited = new Set<string>([current]);
  for (let depth = 0; depth < MAX_MERGE_DEPTH; depth++) {
    const next = settings.feeds[current]?.mergeInto;
    if (!next || visited.has(next)) {
      return current;
    }
    current = next;
    visited.add(current);
  }
  return current;
}

// Exact, case-insensitive sender match on the email address, then the name.
export function FeedSettingsFindSenderRule(
  senderName: string,
  senderEmail: string,
): SenderRule | undefined {
  const email = (senderEmail || "").trim().toLowerCase();
  if (email) {
    const rule = settings.senders[email];
    if (rule) return rule;
  }
  const name = (senderName || "").trim().toLowerCase();
  if (name) {
    const rule = settings.senders[name];
    if (rule) return rule;
  }
  return undefined;
}

// Every feed id referenced by the settings: configured feeds, merge targets and
// sender-rule targets. Used to preserve tokens of feeds that are currently
// empty, hidden or merged away.
export function FeedSettingsGetReferencedFeedIds(): string[] {
  const ids = new Set<string>();
  for (const [feedId, entry] of Object.entries(settings.feeds)) {
    ids.add(feedId);
    if (entry.mergeInto) ids.add(entry.mergeInto);
  }
  for (const entry of Object.values(settings.senders)) {
    if (entry.feedId) ids.add(entry.feedId);
  }
  return [...ids].sort();
}
