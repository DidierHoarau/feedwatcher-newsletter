import { EmailDataGetUidState, EmailsDataGetRecordCount } from "./emails/EmailsData";
import { IdleWatcherGetState } from "./emails/IdleWatcher";
import { SanitizedBodyCacheStats } from "./emails/SanitizedBodyCache";

export interface ServerStatus {
  started: boolean;
  lastSuccessfulFetchAt: string | null;
  lastUid: number;
  uidvalidity: number;
  recordCount: number;
  idle: { enabled: boolean; connected: boolean };
  sanitizedBodyCache: { entries: number; bytes: number };
  lastError: string | null;
}

// In-memory fetch state without the UID reads of ServerStatusGet: the health
// banner and the catalogue use it on every request, and a missing UID file
// must not be consulted there.
export interface ServerFetchState {
  lastSuccessfulFetchAt: string | null;
  lastError: string | null;
  lastChangeAtMs: number;
}

// In-memory fetch health: reset on restart, deliberately not persisted. The
// endpoint is unauthenticated, so errors are reduced to one truncated line
// (no stacks, credentials or email content).
let lastSuccessfulFetchAt: string | null = null;
let lastError: string | null = null;
let lastChangeAtMs = 0;

export function ServerStatusRecordFetchSuccess(atMs: number = Date.now()): void {
  lastSuccessfulFetchAt = new Date(atMs).toISOString();
  lastError = null;
  lastChangeAtMs = atMs;
}

export function ServerStatusRecordFetchError(
  error: unknown,
  atMs: number = Date.now(),
): void {
  const message = error instanceof Error ? error.message : String(error);
  lastError = message.replace(/\s+/g, " ").trim().slice(0, 500) || "unknown error";
  lastChangeAtMs = atMs;
}

export function ServerStatusGetFetchState(): ServerFetchState {
  return { lastSuccessfulFetchAt, lastError, lastChangeAtMs };
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
    sanitizedBodyCache: SanitizedBodyCacheStats(),
    lastError,
  };
}
