import Imap from "imap";
import { simpleParser } from "mailparser";
import { Span } from "@opentelemetry/sdk-trace-base";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../Config";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { TimeoutWait } from "../utils-std-ts/Timeout";
import { FeedIdentityGetFeedId, FeedIdentityIsSenderIgnored } from "../feeds/FeedIdentity";
import { HtmlSanitizerTextToHtml } from "./HtmlSanitizer";
import {
  EmailDataGetLastUid,
  EmailDataSetLastUid,
  EmailItemsBatchSave,
  EmailItemsGetExistingIds,
} from "./EmailsData";

const logger = OTelLogger().createModuleLogger("EmailFetcher");

// Emails are fetched, parsed and persisted in small slices so memory stays
// bounded even when a whole backlog (potentially thousands of emails) is
// re-ingested after a restart.
const FETCH_SLICE_SIZE = 50;
const PARSE_CONCURRENCY = 5;
const SLICE_PAUSE_MS = 250;
const BATCH_PAUSE_MS = 2000;

export interface EmailItem {
  id: string;
  messageId: string;
  senderName: string;
  senderEmail: string;
  subject: string;
  body: string;
  dateReceived: string;
  dateCreated: string;
}

export async function EmailFetcherFetchEmails(
  context: Span,
  config: Config,
): Promise<void> {
  const span = OTelTracer().startSpan("EmailFetcherFetchEmails", context);
  logger.info("Fetching emails from IMAP server", span);

  // Load persisted highest UID so we only fetch messages newer than the
  // previous run.  On the very first run lastUid is 0 → we fetch ALL.
  const lastUid = EmailDataGetLastUid();
  const batchSize = config.EMAIL_FETCH_BATCH_SIZE || 200;
  const runBudget = config.EMAIL_FETCH_RUN_BUDGET || batchSize;

  // Read existing message-IDs once so the per-email dedup check is a
  // fast in-memory Set lookup instead of a disk read for every email.
  const existingIds = EmailItemsGetExistingIds();

  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.IMAP_USER,
      password: config.IMAP_PASSWORD,
      host: config.IMAP_HOST,
      port: config.IMAP_PORT,
      tls: config.IMAP_TLS,
      tlsOptions: { rejectUnauthorized: false },
    });

    imap.once("ready", () => {
      imap.openBox(config.IMAP_MAILBOX, false, (err, _box) => {
        if (err) {
          logger.error(`Error opening mailbox`, err, span);
          imap.end();
          span.end();
          reject(err);
          return;
        }

        imap.search(["ALL"], async (searchErr, uids) => {
          if (searchErr) {
            logger.error(`Error searching emails`, searchErr, span);
            imap.end();
            span.end();
            reject(searchErr);
            return;
          }

          if (!uids || uids.length === 0) {
            logger.info("No emails found", span);
            imap.end();
            span.end();
            resolve();
            return;
          }

          // Filter to UIDs that are newer than the last processed UID.
          // On the first run (lastUid === 0) this is a no-op.
          const newUids =
            lastUid > 0
              ? (uids as number[]).filter((uid) => uid > lastUid)
              : uids;

          if (newUids.length === 0) {
            logger.info("No new emails since last fetch", span);
            imap.end();
            span.end();
            resolve();
            return;
          }

          logger.info(
            `Found ${uids.length} total, ${newUids.length} new (run budget: ${runBudget})`,
            span,
          );

          // Catch-up: process successive batches within the same run so a
          // backlog larger than the batch size drains instead of progressing
          // one batch per run. Bounded by the per-run budget. A short pause
          // between batches lets GC and the event loop (liveness probes)
          // breathe instead of hammering through a whole backlog.
          let processed = 0;
          let offset = 0;
          try {
            while (offset < newUids.length && processed < runBudget) {
              const take = Math.min(batchSize, runBudget - processed);
              const batchUids = newUids.slice(offset, offset + take);
              const saved = await processBatch(
                imap,
                batchUids,
                existingIds,
                span,
              );
              processed += batchUids.length;
              offset += take;
              if (saved > 0) {
                logger.info(
                  `Saved ${saved} new email(s) (${processed}/${newUids.length} processed this run)`,
                  span,
                );
              }
              if (offset < newUids.length && processed < runBudget) {
                await TimeoutWait(BATCH_PAUSE_MS);
              }
            }
          } catch (loopError) {
            logger.error(`Error during fetch loop`, loopError as Error, span);
            imap.end();
            span.end();
            reject(loopError as Error);
            return;
          }

          imap.end();
          span.end();
          resolve();
        });
      });
    });

    imap.once("error", (err) => {
      logger.error(`IMAP connection error`, err, span);
      span.end();
      reject(err);
    });

    imap.once("end", () => {
      logger.info("IMAP connection ended", span);
    });

    imap.connect();
  });
}

// Fetch, parse and persist one batch of UIDs, in bounded slices: memory stays
// proportional to a slice (50 emails), never to the whole batch or backlog.
// The last-uid marker advances after each slice so an interrupted run resumes
// where it stopped.
async function processBatch(
  imap: Imap,
  batchUids: number[],
  existingIds: Set<string>,
  span: Span,
): Promise<number> {
  let savedTotal = 0;
  for (let offset = 0; offset < batchUids.length; offset += FETCH_SLICE_SIZE) {
    const sliceUids = batchUids.slice(offset, offset + FETCH_SLICE_SIZE);
    const rawEmails = await fetchSlice(imap, sliceUids, span);
    const saved = await parseAndSaveSlice(rawEmails, existingIds, span);
    savedTotal += saved;

    // Persist the highest UID of this slice so the next fetch (or the next
    // run) only retrieves messages beyond this point.
    const maxUid = Math.max(...sliceUids);
    EmailDataSetLastUid(maxUid);
    logger.info(
      `Slice of ${sliceUids.length} email(s) processed, next fetch will skip UIDs <= ${maxUid}`,
      span,
    );

    if (offset + FETCH_SLICE_SIZE < batchUids.length) {
      await TimeoutWait(SLICE_PAUSE_MS);
    }
  }
  return savedTotal;
}

// Fetch the raw sources of one slice of UIDs.
function fetchSlice(
  imap: Imap,
  sliceUids: number[],
  span: Span,
): Promise<string[]> {
  return new Promise<string[]>((sliceResolve, sliceReject) => {
    const rawEmails: string[] = [];
    const fetch = imap.fetch(sliceUids, { bodies: "" });
    const streamPromises: Promise<void>[] = [];

    fetch.on("message", (_msg, seqno) => {
      const streamPromise = new Promise<void>((msgResolve) => {
        let rawEmail = "";
        _msg.on("body", (stream) => {
          stream.on("data", (chunk) => {
            rawEmail += chunk.toString("utf8");
          });
          stream.once("end", () => {
            rawEmails[seqno] = rawEmail;
            msgResolve();
          });
        });
      });
      streamPromises.push(streamPromise);
    });

    fetch.once("error", (fetchErr) => {
      logger.error(`Fetch error`, fetchErr, span);
      sliceReject(fetchErr);
    });

    fetch.once("end", async () => {
      try {
        await Promise.all(streamPromises);
        sliceResolve(rawEmails);
      } catch (endError) {
        sliceReject(endError as Error);
      }
    });
  });
}

// Parse the raw emails of one slice and persist the new ones in a single
// write. Workers share an index so they compete for the next raw email — up
// to PARSE_CONCURRENCY run in parallel.
async function parseAndSaveSlice(
  rawEmails: string[],
  existingIds: Set<string>,
  span: Span,
): Promise<number> {
  const newItems: EmailItem[] = [];
  const newSenderIds = new Set<string>();
  let emailIndex = 0;

  const processNextEmail = async (): Promise<void> => {
    while (emailIndex < rawEmails.length) {
      const rawEmail = rawEmails[emailIndex++];
      if (!rawEmail) continue;

      try {
        const parsed = await simpleParser(rawEmail);
        const messageId = parsed.messageId || `no-id-${Date.now()}`;

        if (existingIds.has(messageId)) continue;

        // Emails without a From header never become feeds (no
        // "Unknown" pseudo-feed).
        if (!parsed.from || parsed.from.value.length === 0) continue;
        const from = parsed.from.value[0];
        const senderEmail = from.address || "";
        if (!senderEmail) continue;
        const senderName = from.name || senderEmail;

        // Ignored senders (non-newsletter inbox traffic) are skipped.
        if (FeedIdentityIsSenderIgnored(senderName, senderEmail)) continue;

        // Bodies are normalized to HTML: sanitize-html handles the HTML
        // bodies, plain-text bodies are escaped into paragraphs.
        const body =
          parsed.html || HtmlSanitizerTextToHtml(parsed.text || "");

        const emailItem: EmailItem = {
          id: uuidv4(),
          messageId,
          senderName,
          senderEmail,
          subject: parsed.subject || "(no subject)",
          body,
          dateReceived: parsed.date
            ? parsed.date.toISOString()
            : new Date().toISOString(),
          dateCreated: new Date().toISOString(),
        };

        const senderId = FeedIdentityGetFeedId(senderName, senderEmail);
        const isNewSender = !newSenderIds.has(senderId);
        newSenderIds.add(senderId);
        newItems.push(emailItem);
        existingIds.add(messageId);

        if (isNewSender) {
          logger.info(
            `New email from ${senderName} <${senderEmail}> [id: ${senderId}]: ${emailItem.subject}`,
            span,
          );
        }
      } catch (parseError) {
        logger.error(
          `Error parsing email`,
          parseError as Error,
          span,
        );
      }
    }
  };

  const workerCount = Math.min(PARSE_CONCURRENCY, rawEmails.length);
  const workers = Array.from({ length: workerCount }, () =>
    processNextEmail(),
  );
  await Promise.all(workers);

  EmailItemsBatchSave(newItems);
  return newItems.length;
}
