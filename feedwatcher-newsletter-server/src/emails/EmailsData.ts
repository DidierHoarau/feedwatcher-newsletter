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
function walkJournalLines(handleLine: (item: EmailItem) => void): void {
  try {
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
  } catch (err) {
    logger.error(
      `Failed to load email journal from ${journalFilePath}`,
      err as Error,
    );
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
  retentionDays = configuredRetentionDays;
  journalFilePath = path.join(dataDir, "emails.jsonl");
  legacyFilePath = path.join(dataDir, "emails.json");
  migrateLegacyStore();
  logger.info(`Email retention configured to ${retentionDays} day(s)`);
  logger.info(`Email data file: ${journalFilePath}`);
}

// Append the new items as journal lines.
export function EmailItemsBatchSave(items: EmailItem[]): void {
  if (items.length === 0) return;
  try {
    fse.ensureDirSync(path.dirname(journalFilePath));
    const lines = items.map((item) => JSON.stringify(item)).join("\n");
    fse.appendFileSync(journalFilePath, lines + "\n");
  } catch (err) {
    logger.error(`Failed to append to email journal`, err as Error);
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
// materialized.
export function EmailsDataPurgeExpired(): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  const last = new Map<string, { index: number; expired: boolean }>();
  let recordIndex = 0;
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
  const tmpPath = `${journalFilePath}.tmp`;
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
  } finally {
    fse.closeSync(out);
  }
  fse.renameSync(tmpPath, journalFilePath);
  logger.info(
    `Purged ${expiredCount} expired email(s) older than ${retentionDays} day(s)`,
  );
}

// ---------------------------------------------------------------------------
// Incremental IMAP UID tracking — persist last processed UID so subsequent
// fetches only retrieve messages newer than the previous run.
// ---------------------------------------------------------------------------

export function EmailDataGetLastUid(): number {
  const filePath = path.join(path.dirname(journalFilePath), "last-uid.txt");
  try {
    if (fse.existsSync(filePath)) {
      return parseInt(fse.readFileSync(filePath, "utf8").trim(), 10);
    }
  } catch (err) {
    logger.error(`Failed to read last UID from ${filePath}`, err as Error);
  }
  return 0;
}

export function EmailDataSetLastUid(uid: number): void {
  const filePath = path.join(path.dirname(journalFilePath), "last-uid.txt");
  try {
    fse.ensureDirSync(path.dirname(filePath));
    fse.writeFileSync(filePath, String(uid));
  } catch (err) {
    logger.error(`Failed to save last UID to ${filePath}`, err as Error);
  }
}

// Read existing message-IDs once so callers can deduplicate without
// re-reading the journal for every email.
export function EmailItemsGetExistingIds(): Set<string> {
  const ids = new Set<string>();
  walkJournalLines((item) => ids.add(item.messageId));
  return ids;
}
