import RSS from "rss";
import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { EmailItemsListById } from "./EmailsData";

const logger = OTelLogger().createModuleLogger("RssFeedGenerator");

export function RssFeedGeneratorBuildFeedById(
  context: Span,
  id: string,
  baseUrl: string,
): string {
  const span = OTelTracer().startSpan("RssFeedGeneratorBuildFeedById", context);
  logger.info(`Building RSS feed for id: ${id}`, span);

  const emails = EmailItemsListById(id);
  const senderName = emails.length > 0 ? emails[0].senderName : id;

  const feed = new RSS({
    title: senderName,
    description: `Newsletter emails from ${senderName}`,
    feed_url: `${baseUrl}/rss/${id}`,
    site_url: baseUrl,
    language: "en",
  });

  for (const email of emails) {
    feed.item({
      title: email.subject,
      description: email.body,
      url: `${baseUrl}/rss/${id}#${email.id}`,
      guid: email.id,
      date: email.dateReceived,
      custom_elements: [
        { content: email.body },
        { "newsletter:messageId": email.messageId },
        { "newsletter:senderName": email.senderName },
        { "newsletter:senderEmail": email.senderEmail },
        { "newsletter:dateReceived": email.dateReceived },
        { "newsletter:dateCreated": email.dateCreated },
      ],
    });
  }

  span.end();
  return feed.xml({ indent: true });
}
