import RSS from "rss";
import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { EmailItemsListBySender } from "./EmailsData";

const logger = OTelLogger().createModuleLogger("RssFeedGenerator");

export function RssFeedGeneratorBuildFeedForSender(
  context: Span,
  senderName: string,
  baseUrl: string,
): string {
  const span = OTelTracer().startSpan(
    "RssFeedGeneratorBuildFeedForSender",
    context,
  );
  logger.info(`Building RSS feed for sender: ${senderName}`, span);

  const emails = EmailItemsListBySender(senderName);

  const feed = new RSS({
    title: senderName,
    description: `Newsletter emails from ${senderName}`,
    feed_url: `${baseUrl}/rss/${encodeURIComponent(senderName)}`,
    site_url: baseUrl,
    language: "en",
  });

  for (const email of emails) {
    feed.item({
      title: email.subject,
      description: email.body,
      url: `${baseUrl}/rss/${encodeURIComponent(senderName)}#${email.id}`,
      guid: email.id,
      date: email.dateReceived,
    });
  }

  span.end();
  return feed.xml({ indent: true });
}
