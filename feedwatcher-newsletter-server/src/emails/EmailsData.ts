import * as fse from "fs-extra";
import path from "path";
import { StringDecoder } from "string_decoder";
import { OTelLogger } from "../OTelContext";
import {
  FeedIdentityGetFeedId,
  FeedIdentityGetGeneration,
  FeedIdentityGetTitle,
  FeedIdentityIsSenderIgnored,
} from "../feeds/FeedIdentity";
import { EmailItem } from "./EmailFetcher";
import {
  SanitizedBodyCacheEvict,
  SanitizedBodyCacheReset,
} from "./SanitizedBodyCache";

const logger = OTelLogger().createModuleLogger("EmailsData");

export interface FeedSummary {
  feedId: string;
  title: string;
  senderName: string;
  senderEmail: string;
  itemCount: number;
  latestDate: string;
}

let retentionDays = 3;
let journalFilePath = "";
let legacyFilePath = "";

// In-memory view of the journal, the single source of truth on disk. Built
// once from one pass at init, then updated write-through on every durable
// append and purge, so reads never touch the filesystem. The journal may hold
// several records per message; the LAST one is the current state.
let recordsByMessageId = new Map<string, EmailItem>();
let itemById = new Map<string, EmailItem>();
let recordCounts = new Map<string, number>();

// Derived, lazily rebuilt per feed: grouping is pure in-memory work and is
// invalidated by writes and by feed-identity configuration changes.
interface FeedIndex {
  identityGeneration: number;
  itemsByFeedId: Map<string, EmailItem[]>;
  summaries: FeedSummary[];
  lastModifiedByFeed: Map<string, number>;
  lastModifiedMs: number;
}

let feedIndex: FeedIndex | undefined;
let storeMutationAtMs = 0;
// A feed that lost items on purge gets a fresh Last-Modified even when its
// remaining content is older than the mutation.
let feedMutationAtMs = new Map<string, number>();
// Collision signatures already warned about: frequent index rebuilds must not
// repeat the same warning.
let loggedCollisions = new Set<string>();

// One JSON record per line, appended on each save: writes cost O(new items),
// never O(store). This keeps ingestion memory flat even when a whole mailbox
// backlog is re-ingested after a restart (a full read-modify-write of the
// store per batch OOMs a small container). The hourly purge compacts the
// journal back to one record per message.
const READ_CHUNK_BYTES = 1024 * 1024;

// Walk the journal line by line without ever loading the file as one giant
// string, invoking the handler for every valid record. Used at startup and by
// the purge compaction; request paths never call it. I/O errors propagate: a
// partially read journal must never be mistaken for the real store.
function walkJournalLines(handleLine: (item: EmailItem) => void): void {
  if (!fse.existsSync(journalFilePath)) {
    return;
  }
  const fd = fse.openSync(journalFilePath, "r");
  try {
    const chunk = Buffer.alloc(READ_CHUNK_BYTES);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    let bytesRead = 0;
    const processLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const item = JSON.parse(line) as EmailItem;
        if (item && item.messageId) {
          handleLine(item);
        }
      } catch {
        // Skip a malformed/partial line rather than losing the store.
      }
    };
    while ((bytesRead = fse.readSync(fd, chunk, 0, READ_CHUNK_BYTES, null)) > 0) {
      const text = carry + decoder.write(chunk.subarray(0, bytesRead));
      const lines = text.split("\n");
      carry = lines.pop() || "";
      for (const line of lines) {
        processLine(line);
      }
    }
    carry += decoder.end();
    processLine(carry);
  } finally {
    fse.closeSync(fd);
  }
}

// One-time migration of the legacy single-JSON-array store (emails.json).
// The journal is appended and the legacy file is kept aside, renamed.
function migrateLegacyStore(): void {
  try {
    if (!fse.existsSync(legacyFilePath)) {
      return;
    }
    const records: EmailItem[] = fse.readJsonSync(legacyFilePath);
    if (records.length > 0) {
      fse.ensureDirSync(path.dirname(journalFilePath));
      const lines = records.map((item) => JSON.stringify(item)).join("\n");
      fse.appendFileSync(journalFilePath, lines + "\n");
    }
    fse.renameSync(legacyFilePath, `${legacyFilePath}.migrated`);
    logger.info(
      `Migrated legacy store ${legacyFilePath} (${records.length} email(s)) to ${journalFilePath}`,
    );
  } catch (err) {
    logger.error(
      `Failed to migrate legacy store ${legacyFilePath}`,
      err as Error,
    );
  }
}

function indexRecord(item: EmailItem): void {
  const previous = recordsByMessageId.get(item.messageId);
  if (previous && previous.id !== item.id) {
    itemById.delete(previous.id);
  }
  recordsByMessageId.set(item.messageId, item);
  itemById.set(item.id, item);
  recordCounts.set(item.messageId, (recordCounts.get(item.messageId) || 0) + 1);
}

export function EmailsDataInit(
  configuredRetentionDays: number,
  dataDir: string,
): void {
  EmailsDataSetRetentionDays(configuredRetentionDays);
  journalFilePath = path.join(dataDir, "emails.jsonl");
  legacyFilePath = path.join(dataDir, "emails.json");
  migrateLegacyStore();
  recordsByMessageId = new Map();
  itemById = new Map();
  recordCounts = new Map();
  feedIndex = undefined;
  storeMutationAtMs = 0;
  feedMutationAtMs = new Map();
  loggedCollisions = new Set();
  SanitizedBodyCacheReset();
  let recordCount = 0;
  walkJournalLines((item) => {
    indexRecord(item);
    recordCount++;
  });
  // The index is the serving source of truth; an unreadable journal must fail
  // the boot instead of silently serving empty feeds.
  logger.info(
    `Email data file: ${journalFilePath} (${recordCount} record(s), ${recordsByMessageId.size} message(s) indexed)`,
  );
}

// Append the new items as journal lines. Only a durable append (fsync before
// close) counts as success: callers must not advance the UID marker otherwise,
// or a failed write would lose the emails permanently. The in-memory index is
// updated only after the append succeeded.
export function EmailItemsBatchSave(items: EmailItem[]): void {
  if (items.length === 0) return;
  try {
    fse.ensureDirSync(path.dirname(journalFilePath));
    const lines = items.map((item) => JSON.stringify(item)).join("\n");
    const fd = fse.openSync(journalFilePath, "a+");
    try {
      // Isolate a partial line left by a previous failed write: without a
      // leading newline the new records would be glued to the fragment.
      const size = fse.fstatSync(fd).size;
      if (size > 0) {
        const lastByte = Buffer.alloc(1);
        fse.readSync(fd, lastByte, 0, 1, size - 1);
        if (lastByte.toString("utf8") !== "\n") {
          fse.writeSync(fd, "\n");
        }
      }
      fse.writeSync(fd, lines + "\n");
      fse.fsyncSync(fd);
    } finally {
      fse.closeSync(fd);
    }
  } catch (err) {
    logger.error(`Failed to append to email journal`, err as Error);
    throw err;
  }
  for (const item of items) {
    indexRecord(item);
  }
  storeMutationAtMs = Date.now();
  for (const item of items) {
    if (!isUnknownSender(item)) {
      feedMutationAtMs.set(
        FeedIdentityGetFeedId(item.senderName, item.senderEmail),
        Date.now(),
      );
    }
  }
  feedIndex = undefined;
}

// Sender-name-only grouping breaks down for senders without a From header;
// such emails are never listed as feeds.
function isUnknownSender(item: EmailItem): boolean {
  return (
    item.senderName === "Unknown" ||
    item.senderEmail === "unknown@unknown.com" ||
    !item.senderEmail
  );
}

// Sender-controlled dates never move an item forward in time: the effective
// received date is the earlier of the Date header and the local ingestion
// time. Journals written before this clamp are handled here without a rewrite.
function effectiveReceivedMs(item: EmailItem): number {
  const received = new Date(item.dateReceived).getTime();
  const created = new Date(item.dateCreated).getTime();
  const validReceived = Number.isFinite(received) ? received : undefined;
  const validCreated = Number.isFinite(created) ? created : undefined;
  if (validReceived !== undefined && validCreated !== undefined) {
    return Math.min(validReceived, validCreated);
  }
  return validReceived ?? validCreated ?? 0;
}

export function EmailItemGetEffectiveDateReceived(item: EmailItem): string {
  return new Date(effectiveReceivedMs(item)).toISOString();
}

function itemTimestampMs(item: EmailItem): number {
  return effectiveReceivedMs(item);
}

// Display label and grouping key of a sender identity. Distinct senders that
// derive the same feed id are reported once per index content.
function senderIdentity(item: EmailItem): string {
  return `${(item.senderName || "").trim().toLowerCase()}\u0000${(
    item.senderEmail || ""
  )
    .trim()
    .toLowerCase()}`;
}

function senderLabel(item: EmailItem): string {
  return `${item.senderName} <${item.senderEmail}>`;
}

function warnFeedIdCollisions(
  sendersByFeedId: Map<string, Map<string, string>>,
): void {
  for (const [feedId, senders] of sendersByFeedId) {
    if (senders.size < 2) continue;
    const signature = `${feedId}\u0001${[...senders.keys()].sort().join("\u0001")}`;
    if (loggedCollisions.has(signature)) continue;
    loggedCollisions.add(signature);
    const labels = [...senders.values()].sort();
    logger.warn(
      `Feed id "${feedId}" is shared by ${labels.length} distinct senders: ${labels.join(
        ", ",
      )}; if unintended, separate them with FEED_OVERRIDES`,
    );
  }
}

function buildFeedIndex(identityGeneration: number): FeedIndex {
  const itemsByFeedId = new Map<string, EmailItem[]>();
  const sendersByFeedId = new Map<string, Map<string, string>>();
  const summaries: FeedSummary[] = [];
  const lastModifiedByFeed = new Map<string, number>();
  let lastModifiedMs = 0;
  for (const item of recordsByMessageId.values()) {
    const timestamp = itemTimestampMs(item);
    if (timestamp > lastModifiedMs) {
      lastModifiedMs = timestamp;
    }
    if (isUnknownSender(item)) continue;
    if (FeedIdentityIsSenderIgnored(item.senderName, item.senderEmail)) continue;
    const feedId = FeedIdentityGetFeedId(item.senderName, item.senderEmail);
    const items = itemsByFeedId.get(feedId);
    if (items) {
      items.push(item);
    } else {
      itemsByFeedId.set(feedId, [item]);
    }
    const senders = sendersByFeedId.get(feedId);
    if (senders) {
      senders.set(senderIdentity(item), senderLabel(item));
    } else {
      sendersByFeedId.set(
        feedId,
        new Map([[senderIdentity(item), senderLabel(item)]]),
      );
    }
    const previous = lastModifiedByFeed.get(feedId) || 0;
    if (timestamp > previous) {
      lastModifiedByFeed.set(feedId, timestamp);
    }
  }
  warnFeedIdCollisions(sendersByFeedId);
  for (const [feedId, items] of itemsByFeedId) {
    items.sort((a, b) => effectiveReceivedMs(b) - effectiveReceivedMs(a));
    const latest = items[0];
    summaries.push({
      feedId,
      title: FeedIdentityGetTitle(latest.senderName, latest.senderEmail),
      senderName: latest.senderName,
      senderEmail: latest.senderEmail,
      itemCount: items.length,
      latestDate: EmailItemGetEffectiveDateReceived(latest),
    });
  }
  summaries.sort(
    (a, b) => a.title.localeCompare(b.title) || a.feedId.localeCompare(b.feedId),
  );
  return {
    identityGeneration,
    itemsByFeedId,
    summaries,
    lastModifiedByFeed,
    lastModifiedMs,
  };
}

function ensureFeedIndex(): FeedIndex {
  const identityGeneration = FeedIdentityGetGeneration();
  if (feedIndex && feedIndex.identityGeneration === identityGeneration) {
    return feedIndex;
  }
  const rebuilt = feedIndex !== undefined;
  feedIndex = buildFeedIndex(identityGeneration);
  if (rebuilt) {
    // A configuration reload can change grouping without a write: move both
    // validator timestamps so cached responses are revalidated.
    const now = Date.now();
    storeMutationAtMs = Math.max(storeMutationAtMs, now);
    for (const feedId of feedIndex.itemsByFeedId.keys()) {
      feedMutationAtMs.set(feedId, now);
    }
  }
  return feedIndex;
}

// One summary per feed, grouped by the override-aware feed id.
export function EmailFeedsListAll(): FeedSummary[] {
  return ensureFeedIndex().summaries.slice();
}

export function EmailItemsListById(id: string): EmailItem[] {
  const items = ensureFeedIndex().itemsByFeedId.get(id);
  return items ? items.slice() : [];
}

// Look up one email by its item id (uuid) for the /view/:emailId pages.
// Item ids only resolve for the current record of a message: a re-saved
// message supersedes the permalink of its earlier record.
export function EmailItemGetById(id: string): EmailItem | undefined {
  const item = itemById.get(id);
  if (!item || FeedIdentityIsSenderIgnored(item.senderName, item.senderEmail)) {
    return undefined;
  }
  return item;
}

export function EmailSendersListAll(): {
  senderName: string;
  senderEmail: string;
}[] {
  const seen = new Map<string, string>();
  for (const item of recordsByMessageId.values()) {
    if (!seen.has(item.senderName)) {
      seen.set(item.senderName, item.senderEmail);
    }
  }
  return Array.from(seen.entries())
    .map(([senderName, senderEmail]) => ({ senderName, senderEmail }))
    .sort((a, b) => a.senderName.localeCompare(b.senderName));
}

function lastModifiedOf(contentTimestampMs: number, mutationAtMs: number): number {
  return Math.min(Date.now(), Math.max(contentTimestampMs, mutationAtMs));
}

// Strong validator time for the whole store: latest content timestamp combined
// with the last successful mutation, never in the future.
export function EmailsDataGetLastModified(): number {
  if (recordsByMessageId.size === 0) {
    return 0;
  }
  return lastModifiedOf(ensureFeedIndex().lastModifiedMs, storeMutationAtMs);
}

export function EmailsDataGetFeedLastModified(feedId: string): number {
  const index = ensureFeedIndex();
  const items = index.itemsByFeedId.get(feedId);
  if (!items || items.length === 0) {
    return 0;
  }
  return lastModifiedOf(
    index.lastModifiedByFeed.get(feedId) || 0,
    feedMutationAtMs.get(feedId) || 0,
  );
}

// Compaction: keep only the last record of each non-expired message, in one
// streaming pass — expired message ids are computed from the in-memory index,
// so the journal is read only to write the compacted copy. Any read or write
// error aborts the purge without touching the journal: rewriting it from a
// partial read would truncate data.
export function EmailsDataPurgeExpired(): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const expired = new Set<string>();
  for (const [messageId, item] of recordsByMessageId) {
    // Retention runs from local ingestion time: a sender-controlled Date
    // header can neither purge an email early nor keep it forever. A record
    // without a parsable ingestion time cannot be aged out safely, so it is
    // treated as expired instead of being retained indefinitely.
    const createdAt = new Date(item.dateCreated).getTime();
    if (!Number.isFinite(createdAt) || createdAt < cutoff) {
      expired.add(messageId);
    }
  }
  if (expired.size === 0) {
    return;
  }
  const expiredItemIds: string[] = [];
  const affectedFeedIds = new Set<string>();
  for (const messageId of expired) {
    const item = recordsByMessageId.get(messageId);
    if (!item) continue;
    expiredItemIds.push(item.id);
    if (!isUnknownSender(item)) {
      affectedFeedIds.add(
        FeedIdentityGetFeedId(item.senderName, item.senderEmail),
      );
    }
  }
  let tmpPath = "";
  try {
    tmpPath = `${journalFilePath}.tmp`;
    fse.ensureDirSync(path.dirname(journalFilePath));
    const out = fse.openSync(tmpPath, "w");
    try {
      const seenOrdinals = new Map<string, number>();
      walkJournalLines((item) => {
        const ordinal = (seenOrdinals.get(item.messageId) || 0) + 1;
        seenOrdinals.set(item.messageId, ordinal);
        const knownCount = recordCounts.get(item.messageId);
        // Only the last record of a message is written; records of unknown
        // messages (journal edited outside the process) are kept defensively.
        if (knownCount === undefined || ordinal === knownCount) {
          if (!expired.has(item.messageId)) {
            fse.writeSync(out, JSON.stringify(item) + "\n");
          }
        }
      });
      fse.fsyncSync(out);
    } finally {
      fse.closeSync(out);
    }
    fse.renameSync(tmpPath, journalFilePath);
    tmpPath = "";
    for (const messageId of expired) {
      recordsByMessageId.delete(messageId);
      recordCounts.delete(messageId);
    }
    for (const id of expiredItemIds) {
      itemById.delete(id);
    }
    const now = Date.now();
    storeMutationAtMs = now;
    for (const feedId of affectedFeedIds) {
      feedMutationAtMs.set(feedId, now);
    }
    feedIndex = undefined;
    SanitizedBodyCacheEvict(expiredItemIds);
    logger.info(
      `Purged ${expired.size} expired email(s) older than ${retentionDays} day(s)`,
    );
  } catch (err) {
    if (tmpPath) {
      try {
        fse.unlinkSync(tmpPath);
      } catch {
        // The temp file may not exist; nothing to clean up.
      }
    }
    logger.error(
      `Purge aborted, email journal left untouched`,
      err as Error,
    );
  }
}

// ---------------------------------------------------------------------------
// Incremental IMAP UID tracking — persist the last processed UID together with
// the mailbox UIDVALIDITY it belongs to. IMAP UIDs are only meaningful for a
// given UIDVALIDITY: when a mailbox is recreated or migrated, UIDs restart at
// a lower value and a stale marker would silently stop ingestion.
// ---------------------------------------------------------------------------

export interface EmailUidState {
  uid: number;
  uidvalidity: number;
}

function getUidStateFilePath(): string {
  return path.join(path.dirname(journalFilePath), "last-uid.json");
}

export function EmailDataGetUidState(): EmailUidState {
  const jsonPath = getUidStateFilePath();
  try {
    if (fse.existsSync(jsonPath)) {
      const state = fse.readJsonSync(jsonPath) as Partial<EmailUidState>;
      const uid = Number(state?.uid);
      const uidvalidity = Number(state?.uidvalidity);
      if (Number.isFinite(uid) && Number.isFinite(uidvalidity)) {
        return { uid, uidvalidity };
      }
      logger.error(`Invalid last UID state in ${jsonPath}: ${JSON.stringify(state)}`);
      return { uid: 0, uidvalidity: 0 };
    }
    // Legacy marker: keep the UID, UIDVALIDITY is unknown (0) and adopted
    // from the mailbox on the next fetch. The legacy file is left untouched
    // so a rollback to the previous version still resumes correctly.
    const legacyPath = path.join(path.dirname(journalFilePath), "last-uid.txt");
    if (fse.existsSync(legacyPath)) {
      const uid = parseInt(fse.readFileSync(legacyPath, "utf8").trim(), 10);
      if (Number.isFinite(uid)) {
        return { uid, uidvalidity: 0 };
      }
    }
  } catch (err) {
    logger.error(`Failed to read last UID state from ${jsonPath}`, err as Error);
  }
  // A full re-scan is safe: message-id deduplication keeps re-saved items
  // from duplicating.
  return { uid: 0, uidvalidity: 0 };
}

export function EmailDataSetUidState(uid: number, uidvalidity: number): void {
  const jsonPath = getUidStateFilePath();
  const tmpPath = `${jsonPath}.tmp`;
  try {
    fse.ensureDirSync(path.dirname(jsonPath));
    const fd = fse.openSync(tmpPath, "w");
    try {
      fse.writeSync(fd, JSON.stringify({ uid, uidvalidity }));
      fse.fsyncSync(fd);
    } finally {
      fse.closeSync(fd);
    }
    fse.renameSync(tmpPath, jsonPath);
  } catch (err) {
    try {
      fse.unlinkSync(tmpPath);
    } catch {
      // The temp file may not exist; nothing to clean up.
    }
    logger.error(`Failed to save last UID state to ${jsonPath}`, err as Error);
    throw err;
  }
}

export function EmailsDataSetRetentionDays(days: number): void {
  if (!Number.isFinite(days) || days <= 0) {
    logger.warn(`Ignoring invalid EMAIL_RETENTION_DAYS value: ${days}`);
    return;
  }
  retentionDays = days;
  logger.info(`Email retention configured to ${retentionDays} day(s)`);
}

// Existing message-IDs, from the index: the fetch deduplication check must not
// re-read the journal on every run.
export function EmailItemsGetExistingIds(): Set<string> {
  return new Set(recordsByMessageId.keys());
}

// Number of indexed emails (one per unique message id), for the status probe.
export function EmailsDataGetRecordCount(): number {
  return recordsByMessageId.size;
}
