import { OTelLogger } from "../OTelContext";
import { EmailItem } from "./EmailFetcher";

const logger = OTelLogger().createModuleLogger("EmailsData");

// In-memory store: all emails, keyed by messageId for dedup
const emailStore: Map<string, EmailItem> = new Map();

let retentionDays = 3;

export function EmailsDataInit(configuredRetentionDays: number): void {
  retentionDays = configuredRetentionDays;
  logger.info(`Email retention configured to ${retentionDays} day(s)`);
}

export function EmailItemSave(item: EmailItem): void {
  logger.info(`Storing email in memory: ${item.id}`);
  emailStore.set(item.messageId, item);
}

export function EmailItemExistsByMessageId(messageId: string): boolean {
  return emailStore.has(messageId);
}

export function EmailSenderGetId(senderName: string): string {
  return senderName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 64);
}

export function EmailItemsListById(id: string): EmailItem[] {
  return Array.from(emailStore.values())
    .filter((e) => EmailSenderGetId(e.senderName) === id)
    .sort(
      (a, b) =>
        new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
    );
}

export function EmailItemsListBySender(senderName: string): EmailItem[] {
  return Array.from(emailStore.values())
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
  for (const e of emailStore.values()) {
    if (!seen.has(e.senderName)) {
      seen.set(e.senderName, e.senderEmail);
    }
  }
  return Array.from(seen.entries())
    .map(([senderName, senderEmail]) => ({ senderName, senderEmail }))
    .sort((a, b) => a.senderName.localeCompare(b.senderName));
}

export function EmailItemsListAll(): EmailItem[] {
  return Array.from(emailStore.values()).sort(
    (a, b) =>
      new Date(b.dateReceived).getTime() - new Date(a.dateReceived).getTime(),
  );
}

export function EmailsDataPurgeExpired(): void {
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let purged = 0;
  for (const [messageId, item] of emailStore.entries()) {
    if (new Date(item.dateReceived).getTime() < cutoff) {
      emailStore.delete(messageId);
      purged++;
    }
  }
  if (purged > 0) {
    logger.info(
      `Purged ${purged} expired email(s) older than ${retentionDays} day(s)`,
    );
  }
}
