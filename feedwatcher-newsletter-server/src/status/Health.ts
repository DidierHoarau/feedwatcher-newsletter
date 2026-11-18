import { Config } from "../Config";
import { EmailsDataGetStorageState } from "../emails/EmailsData";
import { IdleWatcherGetState } from "../emails/IdleWatcher";
import { ServerStatusGetFetchState } from "../ServerStatus";
import { CronIntervalMs } from "./CronInterval";
import { FEED_QUIET_AFTER_DAYS } from "./FeedActivity";
import { HealthFormatDuration } from "./HealthFormat";

export type IngestionHealthStatus = "starting" | "ok" | "degraded" | "stale";

export interface IngestionHealthStorage {
  journalExisted: boolean;
  legacyJournalExisted: boolean;
  uidMarkerExisted: boolean;
  freshDataDirectory: boolean;
}

// Derived health on top of the raw status snapshot. It is computed on demand
// from in-memory state, so it never touches the journal or the mailbox.
export interface IngestionHealth {
  status: IngestionHealthStatus;
  staleAfterSeconds: number;
  quietAfterDays: number;
  lastSuccessfulFetchAt: string | null;
  lastSuccessfulFetchAgeSeconds: number | null;
  idle: { enabled: boolean; connected: boolean };
  lastError: string | null;
  storage: IngestionHealthStorage;
}

function ageSeconds(lastSuccessfulFetchAt: string | null, nowMs: number): number | null {
  if (!lastSuccessfulFetchAt) {
    return null;
  }
  const lastMs = Date.parse(lastSuccessfulFetchAt);
  if (!Number.isFinite(lastMs)) {
    return null;
  }
  return Math.max(0, Math.floor((nowMs - lastMs) / 1000));
}

// "Stale" means the last successful fetch is older than twice the estimated
// cron interval: one missed run is tolerated, two are not. An unparsable cron
// expression falls back to a 1-hour interval, so the threshold is 2 hours.
export function HealthGet(
  config: Config,
  nowMs: number = Date.now(),
): IngestionHealth {
  const fetchState = ServerStatusGetFetchState();
  const idle = IdleWatcherGetState();
  const storage = EmailsDataGetStorageState();
  const staleAfterSeconds = Math.max(
    1,
    Math.round((CronIntervalMs(config.EMAIL_FETCH_CRON, nowMs) * 2) / 1000),
  );
  const age = ageSeconds(fetchState.lastSuccessfulFetchAt, nowMs);

  let status: IngestionHealthStatus;
  if (!fetchState.lastSuccessfulFetchAt) {
    status = fetchState.lastError ? "degraded" : "starting";
  } else if (age !== null && age > staleAfterSeconds) {
    status = "stale";
  } else if (
    fetchState.lastError &&
    idle.enabled &&
    !idle.connected
  ) {
    status = "degraded";
  } else {
    status = "ok";
  }

  return {
    status,
    staleAfterSeconds,
    quietAfterDays: FEED_QUIET_AFTER_DAYS,
    lastSuccessfulFetchAt: fetchState.lastSuccessfulFetchAt,
    lastSuccessfulFetchAgeSeconds: age,
    idle,
    lastError: fetchState.lastError,
    storage,
  };
}

export function HealthNeedsBanner(health: IngestionHealth): boolean {
  return health.status === "stale" || health.status === "degraded";
}

// The renderer escapes this text: the last error comes from an external
// system and may contain anything.
export function HealthBannerMessage(health: IngestionHealth): string {
  if (health.status === "stale") {
    const lastSuccess = health.lastSuccessfulFetchAt
      ? `the last successful fetch was ${health.lastSuccessfulFetchAt} (${HealthFormatDuration(
          health.lastSuccessfulFetchAgeSeconds,
        )} ago)`
      : "no fetch has succeeded yet";
    const suffix = health.lastError
      ? ` The latest attempt failed: ${health.lastError}`
      : "";
    return `Ingestion looks stale: ${lastSuccess}, beyond the ${HealthFormatDuration(
      health.staleAfterSeconds,
    )} threshold.${suffix}`;
  }
  if (health.status === "degraded") {
    const reason = health.lastError
      ? `the latest fetch failed: ${health.lastError}`
      : "the IMAP IDLE connection is down";
    return `Ingestion is degraded: ${reason}.`;
  }
  return "";
}
