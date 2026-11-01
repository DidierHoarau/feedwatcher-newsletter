import { ImapFlow, MailboxLockObject } from "imapflow";
import { simpleParser } from "mailparser";
import { Span } from "@opentelemetry/api";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../Config";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { TimeoutWait } from "../utils-std-ts/Timeout";
import { FeedIdentityGetFeedId, FeedIdentityIsSenderIgnored } from "../feeds/FeedIdentity";
import { HtmlSanitizerTextToHtml } from "./HtmlSanitizer";
import {
  BuildImapFlowOptions,
  ImapLogConnectionError,
  ImapLogConnectionEstablished,
} from "./ImapConnection";
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

  let client: ImapFlow;
  try {
    client = new ImapFlow(
      BuildImapFlowOptions(config, config.IMAP_SOCKET_TIMEOUT_MS, true),
    );
  } catch (optionsError) {
    logger.error(
      `Unable to configure the IMAP connection`,
      optionsError as Error,
      span,
    );
    span.end();
    throw optionsError;
  }
  let lock: MailboxLockObject | undefined;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let closing = false;
    let deadlineTimer: NodeJS.Timeout | undefined;

    // Every termination path (success, error, connection close, deadline)
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
        // close() destroys the socket, which settles any pending operation.
        closing = true;
        client.close();
        finish(deadlineError);
      }, config.EMAIL_FETCH_DEADLINE_MS);
    }

    client.on("error", (err) => {
      if (settled) return;
      ImapLogConnectionError("IMAP connection error", err, config, span);
      finish(err);
    });

    client.on("close", () => {
      if (settled || closing) return;
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

    void (async () => {
      try {
        await client.connect();
        if (settled) return;
        ImapLogConnectionEstablished(config, span);

        lock = await client.getMailboxLock(config.IMAP_MAILBOX, {
          readOnly: false,
        });
        if (settled) return;

        const mailbox = client.mailbox;
        const serverUidvalidity =
          mailbox && typeof mailbox === "object"
            ? Number(mailbox.uidValidity) || 0
            : 0;
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

        const newUids = await searchNewUids(client, lastUid, span);
        if (settled) return;

        if (newUids.length === 0) {
          logger.info(
            lastUid > 0 ? "No new emails since last fetch" : "No emails found",
            span,
          );
        } else {
          logger.info(
            `Found ${newUids.length} new email(s) (run budget: ${runBudget})`,
            span,
          );

          // Catch-up: process successive batches within the same run so a
          // backlog larger than the batch size drains instead of progressing
          // one batch per run. Bounded by the per-run budget. A short pause
          // between batches lets GC and the event loop (liveness probes)
          // breathe instead of hammering through a whole backlog.
          let processed = 0;
          let offset = 0;
          while (offset < newUids.length && processed < runBudget && !settled) {
            const take = Math.min(batchSize, runBudget - processed);
            const batchUids = newUids.slice(offset, offset + take);
            const saved = await processBatch(
              client,
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
        }

        if (settled) return;
        closing = true;
        if (deadlineTimer) {
          clearTimeout(deadlineTimer);
          deadlineTimer = undefined;
        }
        try {
          lock.release();
        } catch {
          // A released or already dropped lock must not fail a completed run.
        }
        lock = undefined;
        // The data is durably saved at this point: a logout failure is not a
        // fetch failure and must not trigger a retry that would re-scan.
        await client.logout().catch(() => client.close());
        finish();
      } catch (err) {
        if (settled) return;
        closing = true;
        ImapLogConnectionError(
          "Error fetching emails from IMAP",
          err,
          config,
          span,
        );
        client.close();
        finish(err as Error);
      } finally {
        try {
          lock?.release();
        } catch {
          // The lock is released either here or on the success path.
        }
        lock = undefined;
      }
    })();
  });
}

// Search for UIDs newer than lastUid. A UID range keeps the search cheap on a
// large mailbox; some servers do not support it, so fall back to ALL and
// filter locally. Note that `n:*` also returns the highest UID when it is
// below n, hence the explicit filter plus ascending sort.
async function searchNewUids(
  client: ImapFlow,
  lastUid: number,
  span: Span,
): Promise<number[]> {
  const filterAndSort = (uids: number[] | false | undefined): number[] =>
    (uids || [])
      .filter((uid) => uid > lastUid)
      .sort((a, b) => a - b);

  const searchAll = async (): Promise<number[]> =>
    filterAndSort(await client.search({ all: true }, { uid: true }));

  if (lastUid <= 0) {
    return searchAll();
  }
  try {
    const uids = await client.search(
      { uid: `${lastUid + 1}:*` },
      { uid: true },
    );
    return filterAndSort(uids);
  } catch {
    logger.warn(
      `UID range search failed, falling back to a full mailbox search`,
      span,
    );
    return searchAll();
  }
}

// Fetch, parse and persist one batch of UIDs, in bounded slices: memory stays
// proportional to a slice (50 emails), never to the whole batch or backlog.
// The last-uid marker advances after each slice only once its items are
// durably saved, so an interrupted run resumes where it stopped without ever
// skipping emails whose write failed.
async function processBatch(
  client: ImapFlow,
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
    const rawEmails = await fetchSlice(client, sliceUids);
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

// Fetch the raw sources of one slice of UIDs. A broken connection makes the
// imapflow async generator throw, which settles the run: a truncated
// connection cannot leave the fetch loop waiting forever.
async function fetchSlice(
  client: ImapFlow,
  sliceUids: number[],
): Promise<string[]> {
  const rawEmails: string[] = [];
  for await (const message of client.fetch(
    sliceUids.join(","),
    { uid: true, source: true },
    { uid: true },
  )) {
    if (message.source) {
      rawEmails.push(message.source.toString("utf8"));
    }
  }
  return rawEmails;
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

        // One timestamp for the whole record, so dateReceived can never be
        // later than the ingestion time. The Date header is sender-controlled:
        // a future date is clamped to now, and an absent/invalid date falls
        // back to now.
        const now = new Date();
        const headerDate = parsed.date ? parsed.date.getTime() : NaN;
        const dateReceived = Number.isFinite(headerDate)
          ? new Date(Math.min(headerDate, now.getTime()))
          : now;

        const emailItem: EmailItem = {
          id: uuidv4(),
          messageId,
          senderName,
          senderEmail,
          subject: parsed.subject || "(no subject)",
          body,
          dateReceived: dateReceived.toISOString(),
          dateCreated: now.toISOString(),
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
