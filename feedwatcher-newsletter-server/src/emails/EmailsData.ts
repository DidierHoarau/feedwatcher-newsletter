import * as fse from "fs-extra";
import path from "path";
import { StringDecoder } from "string_decoder";
import { OTelLogger } from "../OTelContext";
import {
  FeedIdentityGetFeedId,
  FeedIdentityGetTitle,
  FeedIdentityIsSenderIgnored,
} from "../feeds/FeedIdentity";
import { EmailItem } from "./EmailFetcher";

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

// One JSON record per line, appended on each save: writes cost O(new items),
// never O(store). This keeps ingestion memory flat even when a whole mailbox
// backlog is re-ingested after a restart (a full read-modify-write of the
// store per batch OOMs a small container). The hourly purge compacts the
// journal back to one record per message.
const READ_CHUNK_BYTES = 1024 * 1024;

// Walk the journal line by line without ever loading the file as one giant
// string, invoking the handler for every valid record. Readers aggregate on
// the fly instead of materializing the whole store in memory; the journal may
// hold several records per message, the LAST one being the current state.
// I/O errors propagate: a partially read journal must never be mistaken for
// the real store (callers decide how to surface the failure).
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

export function EmailsDataInit(
  configuredRetentionDays: number,
  dataDir: string,
): void {
  EmailsDataSetRetentionDays(configuredRetentionDays);
  journalFilePath = path.join(dataDir, "emails.jsonl");
  legacyFilePath = path.join(dataDir, "emails.json");
  migrateLegacyStore();
  logger.info(`Email data file: ${journalFilePath}`);
}

// Append the new items as journal lines. Only a durable append (fsync before
// close) counts as success: callers must not advance the UID marker otherwise,
// or a failed write would lose the emails permanently.
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
}

export function EmailSenderGetId(senderName: string): string {
  return senderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 64);
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

// One summary per feed, grouped by the override-aware feed id, in a single
// streaming pass over the journal.
export function EmailFeedsListAll(): FeedSummary[] {
  const feeds = new Map<string, FeedSummary>();
  const seen = new Set<string>();
  walkJournalLines((item) => {
    // Re-saved messages appear twice in the journal; counting only the first
    // occurrence keeps summaries stable until compaction merges them.
    if (seen.has(item.messageId)) return;
    seen.add(item.messageId);
    if (isUnknownSender(item)) return;
    if (FeedIdentityIsSenderIgnored(item.senderName, item.senderEmail)) return;
    const feedId = FeedIdentityGetFeedId(item.senderName, item.senderEmail);
    const existing = feeds.get(feedId);
    if (existing) {
      existing.itemCount++;
      if (new Date(item.dateReceived).getTime() > new Date(existing.latestDate).getTime()) {
        existing.latestDate = item.dateReceived;
      }
      return;
    }
    feeds.set(feedId, {
      feedId,
      title: FeedIdentityGetTitle(item.senderName, item.senderEmail),
      senderName: item.senderName,
      senderEmail: item.senderEmail,
      itemCount: 1,
      latestDate: item.dateReceived,
    });
  });
  return Array.from(feeds.values()).sort((a, b) =>
    a.title.localeCompare(b.title),
  );
}

export function EmailItemsListById(id: string): EmailItem[] {
  const items = new Map<string, EmailItem>();
  walkJournalLines((item) => {
    if (
      !isUnknownSender(item) &&
      FeedIdentityGetFeedId(item.senderName, item.senderEmail) === id
    ) {
      // Keyed by messageId: a re-saved message replaces its earlier record.
      items.set(item.messageId, item);
    }
  });
  return Array.from(items.values()).sort(
    (a, b) =>
      new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
  );
}

// Look up one email by its item id (uuid) for the /view/:emailId pages.
// Mirrors the last-wins store: a re-saved message supersedes the permalink of
// its earlier record.
export function EmailItemGetById(id: string): EmailItem | undefined {
  let found: EmailItem | undefined;
  let foundIndex = -1;
  let lastSameMessageIndex = -1;
  let recordIndex = 0;
  walkJournalLines((item) => {
    const idx = recordIndex++;
    if (found && item.messageId === found.messageId) {
      lastSameMessageIndex = idx;
      if (item.id === id) {
        found = item;
        foundIndex = idx;
      }
    } else if (item.id === id) {
      found = item;
      foundIndex = idx;
      lastSameMessageIndex = idx;
    }
  });
  return lastSameMessageIndex > foundIndex ? undefined : found;
}

export function EmailSendersListAll(): {
  senderName: string;
  senderEmail: string;
}[] {
  const seen = new Map<string, string>();
  walkJournalLines((e) => {
    if (!seen.has(e.senderName)) {
      seen.set(e.senderName, e.senderEmail);
    }
  });
  return Array.from(seen.entries())
    .map(([senderName, senderEmail]) => ({ senderName, senderEmail }))
    .sort((a, b) => a.senderName.localeCompare(b.senderName));
}

// Compaction: keep only the last record of each non-expired message, in two
// streaming passes with O(message-ids) memory — the store is never
// materialized. Any read or write error aborts the purge without touching the
// journal: rewriting it from a partial read would truncate data.
export function EmailsDataPurgeExpired(): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const last = new Map<string, { index: number; expired: boolean }>();
  let recordIndex = 0;
  let tmpPath = "";
  try {
    walkJournalLines((item) => {
      last.set(item.messageId, {
        index: recordIndex++,
        expired: new Date(item.dateReceived).getTime() < cutoff,
      });
    });
    const expiredCount = Array.from(last.values()).filter((e) => e.expired).length;
    if (expiredCount === 0) {
      return;
    }
    tmpPath = `${journalFilePath}.tmp`;
    fse.ensureDirSync(path.dirname(journalFilePath));
    const out = fse.openSync(tmpPath, "w");
    try {
      recordIndex = 0;
      walkJournalLines((item) => {
        const state = last.get(item.messageId);
        if (state && state.index === recordIndex && !state.expired) {
          fse.writeSync(out, JSON.stringify(item) + "\n");
        }
        recordIndex++;
      });
      fse.fsyncSync(out);
    } finally {
      fse.closeSync(out);
    }
    fse.renameSync(tmpPath, journalFilePath);
    tmpPath = "";
    logger.info(
      `Purged ${expiredCount} expired email(s) older than ${retentionDays} day(s)`,
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

// Read existing message-IDs once so callers can deduplicate without
// re-reading the journal for every email.
export function EmailItemsGetExistingIds(): Set<string> {
  const ids = new Set<string>();
  walkJournalLines((item) => ids.add(item.messageId));
  return ids;
}
