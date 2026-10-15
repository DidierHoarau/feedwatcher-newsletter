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
  EmailSendersListAll,
} from "./emails/EmailsData";
import {
  FeedIdentityGetFeedId,
  FeedIdentityGetFeedUrlId,
  FeedIdentityInit,
} from "./feeds/FeedIdentity";

const logger = OTelLogger().createModuleLogger("Scheduler");

function logAvailableFeeds(span: Span): void {
  const senders = EmailSendersListAll();
  if (senders.length === 0) {
    logger.info("No RSS feeds", span);
    return;
  }
  for (const s of senders) {
    const id = FeedIdentityGetFeedId(s.senderName, s.senderEmail);
    const urlId = FeedIdentityGetFeedUrlId(id);
    const url = config.PUBLIC_URL ? `${config.PUBLIC_URL}/rss/${urlId}` : `/rss/${urlId}`;
    logger.info(
      `RSS Feed: [${id}] ${s.senderName} <${s.senderEmail}> ${url}`,
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

export async function SchedulerInit(context: Span, configIn: Config) {
  const span = OTelTracer().startSpan("SchedulerInit", context);
  config = configIn;

  EmailsDataInit(Number(config.EMAIL_RETENTION_DAYS), config.DATA_DIR);
  FeedIdentityInit({
    ignoreList: config.SENDER_IGNORE_LIST,
    overrides: config.FEED_OVERRIDES,
    privateUrls: config.FEED_PRIVATE_URLS,
    dataDir: config.DATA_DIR,
  });

  logger.info(
    `Scheduling email fetch with cron: ${config.EMAIL_FETCH_CRON}`,
    span,
  );

  // Near-real-time ingestion via IMAP IDLE (the cron schedule stays as
  // fallback and also performs the retention purge)
  IdleWatcherStart(config, () => {
    const idleSpan = OTelTracer().startSpan("IdleEmailFetch");
    fetchEmailsWithRetry(idleSpan, config)
      .then(() => idleSpan.end())
      .catch((err) => {
        logger.error(`Error fetching emails on IDLE trigger`, err, idleSpan);
        idleSpan.end();
      });
  });

  // Run immediately on startup
  fetchEmailsWithRetry(span, config)
    .then(() => logAvailableFeeds(span))
    .catch((err) => {
      logger.error(`Error fetching emails on startup`, err, span);
    });

  // Schedule hourly (or per configured cron)
  schedule.scheduleJob(config.EMAIL_FETCH_CRON, () => {
    const jobSpan = OTelTracer().startSpan("ScheduledEmailFetch");
    EmailsDataPurgeExpired();
    fetchEmailsWithRetry(jobSpan, config)
      .then(() => {
        logAvailableFeeds(jobSpan);
        jobSpan.end();
      })
      .catch((err) => {
        logger.error(`Error fetching emails on schedule`, err, jobSpan);
        jobSpan.end();
      });
  });

  span.end();
}
