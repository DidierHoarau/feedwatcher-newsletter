import * as fse from "fs-extra";
import path from "path";
import { OTelLogger } from "../OTelContext";
import { EmailItem } from "./EmailFetcher";

const logger = OTelLogger().createModuleLogger("EmailsData");

let retentionDays = 3;
let dataFilePath = "";

// Read all records from disk. Never held in memory between calls.
function readStore(): Map<string, EmailItem> {
  try {
    if (fse.existsSync(dataFilePath)) {
      const records: EmailItem[] = fse.readJsonSync(dataFilePath);
      return new Map(records.map((e) => [e.messageId, e]));
    }
  } catch (err) {
    logger.error(
      `Failed to load email store from ${dataFilePath}`,
      err as Error,
    );
  }
  return new Map();
}

// Write records to disk and release the Map immediately.
function writeStore(store: Map<string, EmailItem>): void {
  try {
    fse.ensureDirSync(path.dirname(dataFilePath));
    fse.writeJsonSync(dataFilePath, Array.from(store.values()), { spaces: 2 });
  } catch (err) {
    logger.error(`Failed to save email store to ${dataFilePath}`, err as Error);
  }
}

export function EmailsDataInit(
  configuredRetentionDays: number,
  dataDir: string,
): void {
  retentionDays = configuredRetentionDays;
  dataFilePath = path.join(dataDir, "emails.json");
  logger.info(`Email retention configured to ${retentionDays} day(s)`);
  logger.info(`Email data file: ${dataFilePath}`);
}

// Save multiple items at once: one read + one write, then drop the Map.
export function EmailItemsBatchSave(items: EmailItem[]): void {
  if (items.length === 0) return;
  const store = readStore();
  for (const item of items) {
    store.set(item.messageId, item);
  }
  writeStore(store);
}

export function EmailItemExistsByMessageId(messageId: string): boolean {
  return readStore().has(messageId);
}

export function EmailSenderGetId(senderName: string): string {
  return senderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 64);
}

export function EmailItemsListById(id: string): EmailItem[] {
  return Array.from(readStore().values())
    .filter((e) => EmailSenderGetId(e.senderName) === id)
    .sort(
      (a, b) =>
        new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
    );
}

export function EmailItemsListBySender(senderName: string): EmailItem[] {
  return Array.from(readStore().values())
    .filter((e) => e.senderName === senderName)
    .sort(
      (a, b) =>
        new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
    );
}

export function EmailSendersListAll(): {
  senderName: string;
  senderEmail: string;
}[] {
  const seen = new Map<string, string>();
  for (const e of readStore().values()) {
    if (!seen.has(e.senderName)) {
      seen.set(e.senderName, e.senderEmail);
    }
  }
  return Array.from(seen.entries())
    .map(([senderName, senderEmail]) => ({ senderName, senderEmail }))
    .sort((a, b) => a.senderName.localeCompare(b.senderName));
}

export function EmailItemsListAll(): EmailItem[] {
  return Array.from(readStore().values()).sort(
    (a, b) =>
      new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
  );
}

export function EmailsDataPurgeExpired(): void {
  const store = readStore();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const [messageId, item] of store.entries()) {
    if (new Date(item.dateReceived).getTime() < cutoff) {
      store.delete(messageId);
      purged++;
    }
  }
  if (purged > 0) {
    writeStore(store);
    logger.info(
      `Purged ${purged} expired email(s) older than ${retentionDays} day(s)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Incremental IMAP UID tracking — persist last processed UID so subsequent
// fetches only retrieve messages newer than the previous run.
// ---------------------------------------------------------------------------

export function EmailDataGetLastUid(): number {
  const dir = path.dirname(dataFilePath);
  const filePath = path.join(dir, "last-uid.txt");
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
  const dir = path.dirname(dataFilePath);
  const filePath = path.join(dir, "last-uid.txt");
  try {
    fse.ensureDirSync(dir);
    fse.writeFileSync(filePath, String(uid));
  } catch (err) {
    logger.error(`Failed to save last UID to ${filePath}`, err as Error);
  }
}

// Read existing message-IDs once so callers can deduplicate without
// hitting the disk for every individual email.
export function EmailItemsGetExistingIds(): Set<string> {
  const store = readStore();
  return new Set(store.keys());
}
