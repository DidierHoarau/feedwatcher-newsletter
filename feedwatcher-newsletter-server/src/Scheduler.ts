import { Span } from "@opentelemetry/sdk-trace-base";
import * as schedule from "node-schedule";
import { Config } from "./Config";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { EmailFetcherFetchEmails } from "./emails/EmailFetcher";
import { IdleWatcherStart } from "./emails/IdleWatcher";
import { TimeoutWait } from "./utils-std-ts/Timeout";
import {
  EmailsDataInit,
  EmailsDataPurgeExpired,
  EmailsDataSetRetentionDays,
  EmailFeedsListAll,
} from "./emails/EmailsData";
import {
  FeedIdentityGetFeedUrlId,
  FeedIdentityInit,
  FeedIdentityPruneTokens,
} from "./feeds/FeedIdentity";

const logger = OTelLogger().createModuleLogger("Scheduler");

// Fields that cannot be applied to a running process; a config change to one
// of them is reported and only takes effect after a restart.
const RESTART_ONLY_FIELDS = [
  "IMAP_HOST",
  "IMAP_PORT",
  "IMAP_TLS",
  "IMAP_USER",
  "IMAP_MAILBOX",
  "IMAP_TLS_INSECURE",
  "IMAP_TLS_CA_FILE",
  "DATA_DIR",
  "API_PORT",
  "TRUST_PROXY",
] as const;

function logAvailableFeeds(span: Span): void {
  try {
    // Only real (non-ignored, non-unknown) feeds: listing raw senders would
    // create tokens for ignored/unknown senders and log duplicates.
    const feeds = EmailFeedsListAll();
    if (feeds.length === 0) {
      logger.info("No RSS feeds", span);
      return;
    }
    for (const feed of feeds) {
      const urlId = FeedIdentityGetFeedUrlId(feed.feedId);
      const url = config.PUBLIC_URL ? `${config.PUBLIC_URL}/rss/${urlId}` : `/rss/${urlId}`;
      logger.info(
        `RSS Feed: [${feed.feedId}] ${feed.senderName} <${feed.senderEmail}> ${url}`,
        span,
      );
    }
  } catch (err) {
    // A journal read error after a successful fetch is not a fetch failure.
    logger.warn(
      `Unable to list available feeds: ${(err as Error).message}`,
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

function runCronFetch(): void {
  const jobSpan = OTelTracer().startSpan("ScheduledEmailFetch");
  EmailsDataPurgeExpired();
  SchedulerTriggerFetch("cron", jobSpan)
    .then(() => {
      logAvailableFeeds(jobSpan);
      jobSpan.end();
    })
    .catch((err) => {
      logger.error(`Error fetching emails on schedule`, err, jobSpan);
      jobSpan.end();
    });
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
  if (fetchInProgress) {
    logger.warn(
      `Skipping ${trigger} email fetch: a fetch is already in progress`,
      context,
    );
    return Promise.resolve();
  }
  fetchInProgress = true;
  return fetchEmailsWithRetry(context, config).finally(() => {
    fetchInProgress = false;
  });
}

export async function SchedulerInit(context: Span, configIn: Config) {
  const span = OTelTracer().startSpan("SchedulerInit", context);
  config = configIn;
  restartOnlySnapshot = snapshotRestartOnly(config);

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

  logger.info(
    `Scheduling email fetch with cron: ${config.EMAIL_FETCH_CRON}`,
    span,
  );

  // Near-real-time ingestion via IMAP IDLE (the cron schedule stays as
  // fallback and also performs the retention purge)
  IdleWatcherStart(config, runIdleFetch);

  // Run immediately on startup
  SchedulerTriggerFetch("startup", span)
    .then(() => logAvailableFeeds(span))
    .catch((err) => {
      logger.error(`Error fetching emails on startup`, err, span);
    });

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
