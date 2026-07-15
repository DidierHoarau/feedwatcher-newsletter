import Imap from "imap";
import { simpleParser } from "mailparser";
import { Span } from "@opentelemetry/sdk-trace-base";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../Config";
import { OTelLogger, OTelTracer } from "../OTelContext";
import {
  EmailDataGetLastUid,
  EmailDataSetLastUid,
  EmailItemsBatchSave,
  EmailItemsGetExistingIds,
  EmailSenderGetId,
} from "./EmailsData";

const logger = OTelLogger().createModuleLogger("EmailFetcher");

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

          // Apply batch limit so a single run is always bounded.
          const batchUids = newUids.slice(0, batchSize) as number[];
          logger.info(
            `Found ${uids.length} total, ${newUids.length} new, fetching ${batchUids.length}`,
            span,
          );

          // Collect raw email buffers as they stream in, then parse
          // with controlled concurrency.
          const rawEmails: string[] = [];
          const fetch = imap.fetch(batchUids, { bodies: "" });
          const streamPromises: Promise<void>[] = [];

          fetch.on("message", (_msg, seqno) => {
            const streamPromise = new Promise<void>((msgResolve) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
          });

          fetch.once("end", async () => {
            // Wait for all stream reads to complete
            await Promise.all(streamPromises);

            // Parse and process with controlled concurrency.
            // Workers share an index so they compete for the next raw
            // email — up to CONCURRENCY run in parallel.
            const CONCURRENCY = 5;
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

                  // Extract sender name and email
                  let senderName = "Unknown";
                  let senderEmail = "unknown@unknown.com";
                  if (parsed.from && parsed.from.value.length > 0) {
                    const from = parsed.from.value[0];
                    senderEmail = from.address || senderEmail;
                    senderName = from.name || from.address || senderName;
                  }

                  const body = parsed.html || parsed.text || "";

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

                  const senderId = EmailSenderGetId(senderName);
                  const isNewSender = !newSenderIds.has(senderId);
                  newSenderIds.add(senderId);
                  newItems.push(emailItem);

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

            const workerCount = Math.min(CONCURRENCY, rawEmails.length);
            const workers = Array.from({ length: workerCount }, () =>
              processNextEmail(),
            );
            await Promise.all(workers);

            // Persist all new emails in a single write
            EmailItemsBatchSave(newItems);
            if (newItems.length > 0) {
              logger.info(`Saved ${newItems.length} new email(s)`, span);
            }

            // Persist the highest UID we processed so the next fetch
            // only retrieves messages beyond this point.
            const maxUid = Math.max(...batchUids);
            EmailDataSetLastUid(maxUid);
            logger.info(`Next fetch will skip UIDs <= ${maxUid}`, span);

            imap.end();
            span.end();
            resolve();
          });
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
