import { Span } from "@opentelemetry/api";
import * as schedule from "node-schedule";
import { Config } from "./Config";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { EmailFetcherFetchEmails } from "./emails/EmailFetcher";
import { IdleWatcherStart, IdleWatcherStop } from "./emails/IdleWatcher";
import { TimeoutWait } from "./utils-std-ts/Timeout";
import {
  EmailsDataInit,
  EmailsDataPurgeExpired,
  EmailsDataSetRetentionDays,
  EmailFeedsListAll,
} from "./emails/EmailsData";
import {
  FeedIdentityEnsureTokens,
  FeedIdentityInit,
  FeedIdentityPruneTokens,
} from "./feeds/FeedIdentity";
import {
  ServerStatusRecordFetchError,
  ServerStatusRecordFetchSuccess,
} from "./ServerStatus";

const logger = OTelLogger().createModuleLogger("Scheduler");

// Fields that cannot be applied to a running process; a config change to one
// of them is reported and only takes effect after a restart. IMAP settings are
// deliberately absent: the fetcher re-reads the shared mutable Config on every
// fetch, and the IDLE connection applies them on its next reconnect.
const RESTART_ONLY_FIELDS = [
  "DATA_DIR",
  "API_PORT",
  "TRUST_PROXY",
  "OPENTELEMETRY_COLLECTOR_HTTP_TRACES",
  "OPENTELEMETRY_COLLECTOR_HTTP_METRICS",
  "OPENTELEMETRY_COLLECTOR_HTTP_LOGS",
  "OPENTELEMETRY_COLLECTOR_AWS",
  "OPENTELEMETRY_COLLECTOR_EXPORT_LOGS_INTERVAL_SECONDS",
  "OPENTELEMETRY_COLLECTOR_EXPORT_METRICS_INTERVAL_SECONDS",
  "OPENTELEMETRY_COLLECT_AUTHORIZATION_HEADER",
] as const;

const SHUTDOWN_WAIT_TIMEOUT_MS = 10000;

function logAvailableFeeds(span: Span): void {
  try {
    logger.info(`Available RSS feeds: ${EmailFeedsListAll().length}`, span);
  } catch (err) {
    // A journal read error after a successful fetch is not a fetch failure.
    logger.warn(
      `Unable to list available feeds: ${(err as Error).message}`,
      span,
    );
  }
}

// Persist missing feed tokens in one batch after an index build, so listing
// requests never write. Token persistence must never fail a fetch or a reload.
function ensureFeedTokens(span?: Span): void {
  try {
    FeedIdentityEnsureTokens(EmailFeedsListAll().map((feed) => feed.feedId));
  } catch (err) {
    logger.warn(
      `Unable to persist feed tokens: ${(err as Error).message}`,
      span,
    );
  }
}

// Fetch with short retries inside the same cycle so a transient IMAP failure
// does not cost a full schedule interval.
async function fetchEmailsWithRetry(
  context: Span,
  configIn: Config,
): Promise<void> {
  const attempts = 1 + Math.max(0, configIn.EMAIL_FETCH_RETRIES);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await EmailFetcherFetchEmails(context, configIn);
      return;
    } catch (err) {
      logger.error(
        `Email fetch attempt ${attempt}/${attempts} failed`,
        err as Error,
        context,
      );
      if (attempt < attempts) {
        logger.info(
          `Retrying email fetch in ${configIn.EMAIL_FETCH_RETRY_DELAY_MS}ms`,
          context,
        );
        await TimeoutWait(configIn.EMAIL_FETCH_RETRY_DELAY_MS);
      } else {
        throw err;
      }
    }
  }
}

let config: Config;
let fetchInProgress = false;
let fetchJob: schedule.Job | undefined;
let appliedCron = "";
let restartOnlySnapshot: Record<string, string> = {};
let stopping = false;
let stopPromise: Promise<void> | undefined;
let currentFetch: Promise<void> | undefined;

function snapshotRestartOnly(configIn: Config): Record<string, string> {
  const snapshot: Record<string, string> = {};
  for (const field of RESTART_ONLY_FIELDS) {
    snapshot[field] = String(configIn[field]);
  }
  return snapshot;
}

function applyFeedIdentity(): void {
  FeedIdentityInit({
    ignoreList: config.SENDER_IGNORE_LIST,
    overrides: config.FEED_OVERRIDES,
    privateUrls: config.FEED_PRIVATE_URLS,
    privateUrlsStrict: config.FEED_PRIVATE_URLS_STRICT,
    dataDir: config.DATA_DIR,
  });
}

function runIdleFetch(): void {
  const idleSpan = OTelTracer().startSpan("IdleEmailFetch");
  SchedulerTriggerFetch("idle", idleSpan)
    .then(() => idleSpan.end())
    .catch((err) => {
      logger.error(`Error fetching emails on IDLE trigger`, err, idleSpan);
      idleSpan.end();
    });
}

// The startup fetch gets its own root span: the SchedulerInit span is ended
// when init returns, so a fetch parented to it would outlive its parent.
function runStartupFetch(): void {
  const startupSpan = OTelTracer().startSpan("StartupEmailFetch");
  SchedulerTriggerFetch("startup", startupSpan)
    .then(() => logAvailableFeeds(startupSpan))
    .catch((err) => {
      logger.error(`Error fetching emails on startup`, err, startupSpan);
    })
    .finally(() => {
      startupSpan.end();
    });
}

// One fetch cycle: retries, refreshes the feed tokens and records the health
// of the run. Callers own the single-flight bookkeeping.
async function executeFetch(context: Span): Promise<void> {
  try {
    await fetchEmailsWithRetry(context, config);
    ensureFeedTokens(context);
    ServerStatusRecordFetchSuccess();
  } catch (err) {
    ServerStatusRecordFetchError(err);
    throw err;
  }
}

function runCronFetch(): void {
  if (stopping) {
    return;
  }
  if (fetchInProgress) {
    logger.warn("Skipping cron email fetch: a fetch is already in progress");
    return;
  }
  fetchInProgress = true;
  const jobSpan = OTelTracer().startSpan("ScheduledEmailFetch");
  // Purge and fetch form one single-flight unit: the fetch never starts while
  // the compaction is running, and the async purge cannot become an unhandled
  // rejection because the whole chain has a catch.
  const run = (async () => {
    try {
      await EmailsDataPurgeExpired();
    } catch (err) {
      // A failed purge must never block ingestion; it is logged and the
      // journal is left untouched by the purge itself.
      logger.error("Error purging expired emails", err, jobSpan);
    }
    await executeFetch(jobSpan);
    logAvailableFeeds(jobSpan);
  })()
    .catch((err) => {
      logger.error(`Error fetching emails on schedule`, err, jobSpan);
    })
    .finally(() => {
      fetchInProgress = false;
      if (currentFetch === run) {
        currentFetch = undefined;
      }
      jobSpan.end();
    });
  currentFetch = run;
}

// Single-flight guard: startup, cron and IDLE triggers can fire concurrently,
// but two fetches must never run at the same time (duplicate work, duplicate
// journal records, and a slower run moving the UID marker backwards).
// A trigger that arrives while a fetch is in progress is skipped: IDLE is
// debounced and the cron run is the fallback, so the skipped work is retried
// by the next trigger.
export function SchedulerTriggerFetch(
  trigger: "startup" | "cron" | "idle",
  context: Span,
): Promise<void> {
  if (stopping) {
    return Promise.resolve();
  }
  if (fetchInProgress) {
    logger.warn(
      `Skipping ${trigger} email fetch: a fetch is already in progress`,
      context,
    );
    return Promise.resolve();
  }
  fetchInProgress = true;
  const run = executeFetch(context).finally(() => {
    fetchInProgress = false;
    if (currentFetch === run) {
      currentFetch = undefined;
    }
  });
  currentFetch = run;
  return run;
}

// Stop the scheduler: no new cron or startup/IDLE work is started, the IDLE
// connection is closed, and the in-flight fetch (or cron purge/fetch) is
// awaited up to timeoutMs so a shutdown can drain journal writes. Idempotent:
// repeated calls share one shutdown promise.
export function SchedulerStop(
  timeoutMs = SHUTDOWN_WAIT_TIMEOUT_MS,
): Promise<void> {
  stopPromise ??= performStop(timeoutMs);
  return stopPromise;
}

async function performStop(timeoutMs: number): Promise<void> {
  stopping = true;
  fetchJob?.cancel();
  fetchJob = undefined;
  IdleWatcherStop();
  const pending = currentFetch;
  if (!pending) {
    return;
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pending.catch(() => undefined),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function SchedulerInit(context: Span, configIn: Config) {
  const span = OTelTracer().startSpan("SchedulerInit", context);
  config = configIn;
  restartOnlySnapshot = snapshotRestartOnly(config);
  stopping = false;
  stopPromise = undefined;
  currentFetch = undefined;
  fetchInProgress = false;

  EmailsDataInit(Number(config.EMAIL_RETENTION_DAYS), config.DATA_DIR);
  applyFeedIdentity();
  // Startup-only pruning: a temporarily changed ignore list must not revoke
  // tokens of feeds that may come back.
  try {
    FeedIdentityPruneTokens(EmailFeedsListAll().map((feed) => feed.feedId));
  } catch (err) {
    logger.warn(
      `Unable to prune feed tokens: ${(err as Error).message}`,
      span,
    );
  }
  // Startup index is built: create the tokens of every current feed in one
  // atomic write, so listing requests never persist.
  ensureFeedTokens(span);

  logger.info(
    `Scheduling email fetch with cron: ${config.EMAIL_FETCH_CRON}`,
    span,
  );

  // Near-real-time ingestion via IMAP IDLE (the cron schedule stays as
  // fallback and also performs the retention purge)
  IdleWatcherStart(config, runIdleFetch);

  // Run immediately on startup
  runStartupFetch();

  // Schedule hourly (or per configured cron)
  fetchJob = schedule.scheduleJob(config.EMAIL_FETCH_CRON, runCronFetch);
  appliedCron = config.EMAIL_FETCH_CRON;

  span.end();
}

// Apply a hot configuration reload: retention, cron schedule, IDLE and feed
// identity take effect immediately; connection/data-directory settings are
// reported as requiring a restart. Invalid values are rejected without
// dropping the previously applied behaviour.
export function SchedulerReload(configIn: Config): void {
  config = configIn;

  EmailsDataSetRetentionDays(Number(config.EMAIL_RETENTION_DAYS));

  if (config.EMAIL_FETCH_CRON !== appliedCron) {
    const nextCron = config.EMAIL_FETCH_CRON;
    let nextJob: schedule.Job | undefined;
    try {
      nextJob = schedule.scheduleJob(nextCron, runCronFetch);
    } catch (err) {
      logger.error(
        `Invalid EMAIL_FETCH_CRON value "${nextCron}": keeping the previous schedule (${appliedCron})`,
        err as Error,
      );
    }
    if (nextJob) {
      // Cancel the old job only once the replacement is scheduled.
      fetchJob?.cancel();
      fetchJob = nextJob;
      appliedCron = nextCron;
      logger.info(`Email fetch rescheduled with cron: ${nextCron}`);
    }
  }

  // Start is idempotent and re-evaluates EMAIL_FETCH_IDLE: it stops the
  // connection when the feature was disabled and keeps the existing one
  // otherwise.
  IdleWatcherStart(config, runIdleFetch);

  applyFeedIdentity();
  // A new/changed override or private-URL mode changes the feed set without a
  // fetch: persist the tokens of the current feeds in one batch.
  ensureFeedTokens();

  const nextSnapshot = snapshotRestartOnly(config);
  const changedFields = RESTART_ONLY_FIELDS.filter(
    (field) => restartOnlySnapshot[field] !== nextSnapshot[field],
  );
  if (changedFields.length > 0) {
    logger.warn(
      `Configuration change requires a restart to take effect: ${changedFields.join(", ")}`,
    );
  }
  restartOnlySnapshot = nextSnapshot;
}
