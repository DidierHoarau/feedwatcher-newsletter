import { EmailDataGetUidState, EmailsDataGetRecordCount } from "./emails/EmailsData";
import { IdleWatcherGetState } from "./emails/IdleWatcher";

export interface ServerStatus {
  started: boolean;
  lastSuccessfulFetchAt: string | null;
  lastUid: number;
  uidvalidity: number;
  recordCount: number;
  idle: { enabled: boolean; connected: boolean };
  lastError: string | null;
}

// In-memory fetch health: reset on restart, deliberately not persisted. The
// endpoint is unauthenticated, so errors are reduced to one truncated line
// (no stacks, credentials or email content).
let lastSuccessfulFetchAt: string | null = null;
let lastError: string | null = null;

export function ServerStatusRecordFetchSuccess(): void {
  lastSuccessfulFetchAt = new Date().toISOString();
  lastError = null;
}

export function ServerStatusRecordFetchError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  lastError = message.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
}

export function ServerStatusGet(): ServerStatus {
  const { uid, uidvalidity } = EmailDataGetUidState();
  return {
    started: true,
    lastSuccessfulFetchAt,
    lastUid: uid,
    uidvalidity,
    recordCount: EmailsDataGetRecordCount(),
    idle: IdleWatcherGetState(),
    lastError,
  };
}
