import * as fse from "fs-extra";
import path from "path";
import { OTelLogger } from "../OTelContext";
import { EmailItem } from "./EmailFetcher";

const logger = OTelLogger().createModuleLogger("EmailsData");

let retentionDays = 3;
let dataFilePath = "";

// Load the email store from the JSON file, returning a Map keyed by messageId
function loadStore(): Map<string, EmailItem> {
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

// Persist the email store to the JSON file
function saveStore(store: Map<string, EmailItem>): void {
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

export function EmailItemSave(item: EmailItem): void {
  logger.info(`Storing email to file: ${item.id}`);
  const store = loadStore();
  store.set(item.messageId, item);
  saveStore(store);
}

export function EmailItemExistsByMessageId(messageId: string): boolean {
  return loadStore().has(messageId);
}

export function EmailSenderGetId(senderName: string): string {
  return senderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 64);
}

export function EmailItemsListById(id: string): EmailItem[] {
  return Array.from(loadStore().values())
    .filter((e) => EmailSenderGetId(e.senderName) === id)
    .sort(
      (a, b) =>
        new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
    );
}

export function EmailItemsListBySender(senderName: string): EmailItem[] {
  return Array.from(loadStore().values())
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
  for (const e of loadStore().values()) {
    if (!seen.has(e.senderName)) {
      seen.set(e.senderName, e.senderEmail);
    }
  }
  return Array.from(seen.entries())
    .map(([senderName, senderEmail]) => ({ senderName, senderEmail }))
    .sort((a, b) => a.senderName.localeCompare(b.senderName));
}

export function EmailItemsListAll(): EmailItem[] {
  return Array.from(loadStore().values()).sort(
    (a, b) =>
      new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
  );
}

export function EmailsDataPurgeExpired(): void {
  const store = loadStore();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const [messageId, item] of store.entries()) {
    if (new Date(item.dateReceived).getTime() < cutoff) {
      store.delete(messageId);
      purged++;
    }
  }
  if (purged > 0) {
    saveStore(store);
    logger.info(
      `Purged ${purged} expired email(s) older than ${retentionDays} day(s)`,
    );
  }
}
