import Imap from "imap";
import { simpleParser } from "mailparser";
import sanitizeHtml from "sanitize-html";
import { Span } from "@opentelemetry/sdk-trace-base";
import { v4 as uuidv4 } from "uuid";
import { Config } from "../Config";
import { OTelLogger, OTelTracer } from "../OTelContext";
import {
  EmailItemSave,
  EmailItemExistsByMessageId,
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

          logger.info(`Found ${uids.length} emails`, span);

          const fetch = imap.fetch(uids, { bodies: "" });
          const parsePromises: Promise<void>[] = [];

          fetch.on("message", (msg) => {
            const parsePromise = new Promise<void>((msgResolve) => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              let rawEmail = "";
              msg.on("body", (stream) => {
                stream.on("data", (chunk) => {
                  rawEmail += chunk.toString("utf8");
                });
                stream.once("end", async () => {
                  try {
                    const parsed = await simpleParser(rawEmail);
                    const messageId = parsed.messageId || `no-id-${Date.now()}`;

                    const alreadyExists = EmailItemExistsByMessageId(messageId);
                    if (alreadyExists) {
                      msgResolve();
                      return;
                    }

                    // Extract sender name and email
                    let senderName = "Unknown";
                    let senderEmail = "unknown@unknown.com";
                    if (parsed.from && parsed.from.value.length > 0) {
                      const from = parsed.from.value[0];
                      senderEmail = from.address || senderEmail;
                      senderName = from.name || from.address || senderName;
                    }

                    // Prefer HTML body, fall back to plain text converted to HTML
                    let body: string;
                    if (parsed.html) {
                      body = sanitizeHtml(parsed.html, {
                        allowedTags: sanitizeHtml.defaults.allowedTags.concat([
                          "img",
                          "h1",
                          "h2",
                          "h3",
                          "h4",
                          "h5",
                          "h6",
                          "figure",
                          "figcaption",
                          "picture",
                          "source",
                        ]),
                        allowedAttributes: {
                          ...sanitizeHtml.defaults.allowedAttributes,
                          "*": ["style", "class", "align"],
                          a: ["href", "name", "target", "rel"],
                          img: ["src", "alt", "width", "height", "style"],
                          td: [
                            "colspan",
                            "rowspan",
                            "width",
                            "align",
                            "valign",
                            "bgcolor",
                            "style",
                          ],
                          th: [
                            "colspan",
                            "rowspan",
                            "width",
                            "align",
                            "valign",
                            "style",
                          ],
                          table: [
                            "width",
                            "cellpadding",
                            "cellspacing",
                            "border",
                            "align",
                            "style",
                          ],
                        },
                        allowedSchemes: ["http", "https", "mailto", "cid"],
                        disallowedTagsMode: "discard",
                      });
                    } else {
                      // Convert plain text to basic HTML paragraphs
                      body = (parsed.text || "")
                        .split(/\n\n+/)
                        .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
                        .join("\n");
                    }

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
                    EmailItemSave(emailItem);
                    logger.info(
                      `Saved email from ${senderName} <${senderEmail}> [id: ${senderId}]: ${emailItem.subject}`,
                      span,
                    );
                  } catch (parseError) {
                    logger.error(
                      `Error parsing email`,
                      parseError as Error,
                      span,
                    );
                  }
                  msgResolve();
                });
              });
            });
            parsePromises.push(parsePromise);
          });

          fetch.once("error", (fetchErr) => {
            logger.error(`Fetch error`, fetchErr, span);
          });

          fetch.once("end", async () => {
            await Promise.all(parsePromises);
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
