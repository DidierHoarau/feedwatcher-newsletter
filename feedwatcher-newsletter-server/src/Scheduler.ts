import { Span } from "@opentelemetry/sdk-trace-base";
import * as schedule from "node-schedule";
import { Config } from "./Config";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { EmailFetcherFetchEmails } from "./emails/EmailFetcher";
import {
  EmailsDataInit,
  EmailsDataPurgeExpired,
  EmailSendersListAll,
  EmailSenderGetId,
} from "./emails/EmailsData";

const logger = OTelLogger().createModuleLogger("Scheduler");

function logAvailableFeeds(span: Span): void {
  const senders = EmailSendersListAll();
  if (senders.length === 0) {
    logger.info("Available feeds: none", span);
    return;
  }
  logger.info(`Available feeds (${senders.length}):`, span);
  for (const s of senders) {
    logger.info(
      `  - [${EmailSenderGetId(s.senderName)}] ${s.senderName} <${s.senderEmail}>`,
      span,
    );
  }
}

let config: Config;

export async function SchedulerInit(context: Span, configIn: Config) {
  const span = OTelTracer().startSpan("SchedulerInit", context);
  config = configIn;

  EmailsDataInit(Number(config.EMAIL_RETENTION_DAYS));

  logger.info(
    `Scheduling email fetch with cron: ${config.EMAIL_FETCH_CRON}`,
    span,
  );

  // Run immediately on startup
  EmailFetcherFetchEmails(span, config)
    .then(() => logAvailableFeeds(span))
    .catch((err) => {
      logger.error(`Error fetching emails on startup`, err, span);
    });

  // Schedule hourly (or per configured cron)
  schedule.scheduleJob(config.EMAIL_FETCH_CRON, () => {
    const jobSpan = OTelTracer().startSpan("ScheduledEmailFetch");
    EmailsDataPurgeExpired();
    EmailFetcherFetchEmails(jobSpan, config)
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
