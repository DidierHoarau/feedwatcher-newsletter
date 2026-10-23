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
  EmailDataGetUidState,
  EmailDataSetUidState,
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

  // Load the persisted highest UID together with the mailbox UIDVALIDITY it
  // belongs to. On the very first run both are 0 → we fetch ALL.
  const storedState = EmailDataGetUidState();
  let lastUid = storedState.uid;
  let uidvalidity = storedState.uidvalidity;
  const batchSize = config.EMAIL_FETCH_BATCH_SIZE || 200;
  const runBudget = config.EMAIL_FETCH_RUN_BUDGET || batchSize;

  // Read existing message-IDs once so the per-email dedup check is a
  // fast in-memory Set lookup instead of a disk read for every email.
  const existingIds = EmailItemsGetExistingIds();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;

    // Every termination path (success, error, connection end/close, deadline)
    // funnels through here: the timer is cleared and the span ended exactly
    // once, so a stalled or truncated connection can never leave the run
    // (or its caller's retry loop) hanging.
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
        deadlineTimer = undefined;
      }
      span.end();
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };

    const imap = new Imap({
      user: config.IMAP_USER,
      password: config.IMAP_PASSWORD,
      host: config.IMAP_HOST,
      port: config.IMAP_PORT,
      tls: config.IMAP_TLS,
      tlsOptions: { rejectUnauthorized: false },
      // node-imap supports socketTimeout at runtime; @types/imap predates it.
      socketTimeout: config.IMAP_SOCKET_TIMEOUT_MS,
    } as Imap.Config & { socketTimeout: number });

    if (config.EMAIL_FETCH_DEADLINE_MS > 0) {
      deadlineTimer = setTimeout(() => {
        const deadlineError = new Error(
          `IMAP fetch deadline exceeded (${config.EMAIL_FETCH_DEADLINE_MS}ms)`,
        );
        logger.error(
          `IMAP fetch deadline exceeded, aborting the run`,
          deadlineError,
          span,
        );
        // destroy() rather than end(): LOGOUT can hang on a stalled socket.
        imap.destroy();
        finish(deadlineError);
      }, config.EMAIL_FETCH_DEADLINE_MS);
    }

    imap.once("ready", () => {
      imap.openBox(config.IMAP_MAILBOX, false, (err, box) => {
        if (settled) return;
        if (err) {
          logger.error(`Error opening mailbox`, err, span);
          imap.destroy();
          finish(err);
          return;
        }

        const serverUidvalidity = Number(box?.uidvalidity) || 0;
        try {
          if (serverUidvalidity > 0 && serverUidvalidity !== uidvalidity) {
            if (uidvalidity === 0) {
              // First run, or a legacy marker without UIDVALIDITY: adopt the
              // mailbox value and keep the stored UID (no re-ingestion).
              uidvalidity = serverUidvalidity;
              EmailDataSetUidState(lastUid, uidvalidity);
              logger.info(
                `IMAP UIDVALIDITY ${serverUidvalidity} recorded for mailbox ${config.IMAP_MAILBOX}`,
                span,
              );
            } else if (lastUid > 0) {
              // UIDs are only valid for one UIDVALIDITY: the mailbox was
              // recreated or migrated and the stored UID is meaningless.
              // Reset the marker and re-scan; the journal is kept and
              // message-id deduplication prevents duplicates.
              logger.warn(
                `IMAP UIDVALIDITY changed for mailbox ${config.IMAP_MAILBOX} (was ${uidvalidity}, now ${serverUidvalidity}): resetting the UID marker; existing journal items are kept`,
                span,
              );
              lastUid = 0;
              uidvalidity = serverUidvalidity;
              EmailDataSetUidState(0, uidvalidity);
            } else {
              uidvalidity = serverUidvalidity;
              EmailDataSetUidState(0, uidvalidity);
            }
          }
        } catch (stateError) {
          logger.error(
            `Failed to persist the IMAP UID state`,
            stateError as Error,
            span,
          );
          imap.destroy();
          finish(stateError as Error);
          return;
        }

        searchNewUids(imap, lastUid, span)
          .then(async (newUids) => {
            if (settled) return;
            if (newUids.length === 0) {
              logger.info(
                lastUid > 0 ? "No new emails since last fetch" : "No emails found",
                span,
              );
              imap.end();
              finish();
              return;
            }

            logger.info(
              `Found ${newUids.length} new email(s) (run budget: ${runBudget})`,
              span,
            );

            // Catch-up: process successive batches within the same run so a
            // backlog larger than the batch size drains instead of progressing
            // one batch per run. Bounded by the per-run budget. A short pause
            // between batches lets GC and the event loop (liveness probes)
            // breathe instead of hammering through a whole backlog.
            try {
              let processed = 0;
              let offset = 0;
              while (offset < newUids.length && processed < runBudget && !settled) {
                const take = Math.min(batchSize, runBudget - processed);
                const batchUids = newUids.slice(offset, offset + take);
                const saved = await processBatch(
                  imap,
                  batchUids,
                  existingIds,
                  span,
                  uidvalidity,
                  () => settled,
                );
                processed += batchUids.length;
                offset += take;
                if (saved > 0) {
                  logger.info(
                    `Saved ${saved} new email(s) (${processed}/${newUids.length} processed this run)`,
                    span,
                  );
                }
                if (offset < newUids.length && processed < runBudget && !settled) {
                  await TimeoutWait(BATCH_PAUSE_MS);
                }
              }
            } catch (loopError) {
              logger.error(`Error during fetch loop`, loopError as Error, span);
              imap.destroy();
              finish(loopError as Error);
              return;
            }

            if (settled) return;
            imap.end();
            finish();
          })
          .catch((searchErr) => {
            if (settled) return;
            logger.error(`Error searching emails`, searchErr, span);
            imap.destroy();
            finish(searchErr);
          });
      });
    });

    imap.once("error", (err) => {
      logger.error(`IMAP connection error`, err, span);
      imap.destroy();
      finish(err);
    });

    imap.once("end", () => {
      if (settled) return;
      const endError = new Error(
        "IMAP connection ended before the fetch completed",
      );
      logger.error(
        `IMAP connection ended before the fetch completed`,
        endError,
        span,
      );
      finish(endError);
    });

    imap.once("close", () => {
      if (settled) return;
      const closeError = new Error(
        "IMAP connection closed before the fetch completed",
      );
      logger.error(
        `IMAP connection closed before the fetch completed`,
        closeError,
        span,
      );
      finish(closeError);
    });

    imap.connect();
  });
}

// Search for UIDs newer than lastUid. A UID range keeps the search cheap on a
// large mailbox; some servers do not support it, so fall back to ALL and
// filter locally. Note that `n:*` also returns the highest UID when it is
// below n, hence the explicit filter plus ascending sort.
function searchNewUids(
  imap: Imap,
  lastUid: number,
  span: Span,
): Promise<number[]> {
  const filterAndSort = (uids: number[] | undefined): number[] =>
    (uids || [])
      .filter((uid) => uid > lastUid)
      .sort((a, b) => a - b);
  return new Promise<number[]>((searchResolve, searchReject) => {
    const searchAll = (): void => {
      imap.search(["ALL"], (err, allUids) => {
        if (err) {
          searchReject(err);
          return;
        }
        searchResolve(filterAndSort(allUids));
      });
    };
    if (lastUid <= 0) {
      searchAll();
      return;
    }
    imap.search([["UID", `${lastUid + 1}:*`]], (err, uids) => {
      if (err) {
        logger.warn(
          `UID range search failed, falling back to a full mailbox search`,
          span,
        );
        searchAll();
        return;
      }
      searchResolve(filterAndSort(uids));
    });
  });
}

// Fetch, parse and persist one batch of UIDs, in bounded slices: memory stays
// proportional to a slice (50 emails), never to the whole batch or backlog.
// The last-uid marker advances after each slice only once its items are
// durably saved, so an interrupted run resumes where it stopped without ever
// skipping emails whose write failed.
async function processBatch(
  imap: Imap,
  batchUids: number[],
  existingIds: Set<string>,
  span: Span,
  uidvalidity: number,
  isSettled: () => boolean,
): Promise<number> {
  let savedTotal = 0;
  for (let offset = 0; offset < batchUids.length; offset += FETCH_SLICE_SIZE) {
    if (isSettled()) break;
    const sliceUids = batchUids.slice(offset, offset + FETCH_SLICE_SIZE);
    const rawEmails = await fetchSlice(imap, sliceUids, span);
    if (isSettled()) break;
    const saved = await parseAndSaveSlice(rawEmails, existingIds, span);
    savedTotal += saved;

    // Persist the highest UID of this slice so the next fetch (or the next
    // run) only retrieves messages beyond this point. EmailItemsBatchSave
    // throws when the append is not durable, which aborts the run and leaves
    // the marker untouched.
    const maxUid = Math.max(...sliceUids);
    EmailDataSetUidState(maxUid, uidvalidity);
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

// Fetch the raw sources of one slice of UIDs. The slice promise also settles
// when the connection ends or errors while it is pending, so a truncated
// connection cannot leave the fetch loop waiting forever.
function fetchSlice(
  imap: Imap,
  sliceUids: number[],
  span: Span,
): Promise<string[]> {
  return new Promise<string[]>((sliceResolve, sliceReject) => {
    let sliceSettled = false;
    const rawEmails: string[] = [];
    const streamPromises: Promise<void>[] = [];

    const cleanup = (): void => {
      imap.removeListener("end", onConnectionLost);
      imap.removeListener("close", onConnectionLost);
      imap.removeListener("error", onConnectionLost);
    };
    const settleResolve = (value: string[]): void => {
      if (sliceSettled) return;
      sliceSettled = true;
      cleanup();
      sliceResolve(value);
    };
    const settleReject = (err: Error): void => {
      if (sliceSettled) return;
      sliceSettled = true;
      cleanup();
      sliceReject(err);
    };
    function onConnectionLost(err?: Error): void {
      settleReject(
        err instanceof Error
          ? err
          : new Error("IMAP connection ended before the fetch slice completed"),
      );
    }
    imap.on("end", onConnectionLost);
    imap.on("close", onConnectionLost);
    imap.on("error", onConnectionLost);

    let fetch;
    try {
      fetch = imap.fetch(sliceUids, { bodies: "" });
    } catch (fetchErr) {
      settleReject(fetchErr as Error);
      return;
    }

    fetch.on("message", (msg) => {
      const streamPromise = new Promise<void>((msgResolve) => {
        let rawEmail = "";
        msg.on("body", (stream) => {
          stream.on("data", (chunk) => {
            rawEmail += chunk.toString("utf8");
          });
          stream.once("end", () => {
            // Dense array: entries are appended in completion order instead
            // of indexing by mailbox sequence number (sparse arrays).
            rawEmails.push(rawEmail);
            msgResolve();
          });
        });
      });
      streamPromises.push(streamPromise);
    });

    fetch.once("error", (fetchErr) => {
      logger.error(`Fetch error`, fetchErr, span);
      settleReject(fetchErr);
    });

    fetch.once("end", async () => {
      try {
        await Promise.all(streamPromises);
        settleResolve(rawEmails);
      } catch (endError) {
        settleReject(endError as Error);
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
        // A UUID cannot collide between distinct messages, unlike a
        // millisecond timestamp.
        const messageId = parsed.messageId || `no-id-${uuidv4()}`;

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
