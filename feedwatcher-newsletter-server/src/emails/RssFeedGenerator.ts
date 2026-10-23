import RSS from "rss";
import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelTracer } from "../OTelContext";
import { FeedIdentityGetFeedUrlId, FeedIdentityGetTitle } from "../feeds/FeedIdentity";
import { HtmlSanitizerGetTextSummary, HtmlSanitizerSanitize } from "./HtmlSanitizer";
import { EmailItemsListById } from "./EmailsData";

const logger = OTelLogger().createModuleLogger("RssFeedGenerator");

const FEED_TTL_MINUTES = 60;

export function RssFeedGeneratorBuildFeedById(
  context: Span,
  id: string,
  baseUrl: string,
  stripTrackingPixels = true,
): string | undefined {
  const span = OTelTracer().startSpan("RssFeedGeneratorBuildFeedById", context);
  logger.info(`Building RSS feed for id: ${id}`, span);

  const emails = EmailItemsListById(id);
  // An unknown (or ignored) feed has no emails: do not advertise it or create
  // a token for it.
  if (emails.length === 0) {
    span.end();
    return undefined;
  }
  const senderName = emails[0].senderName;
  const senderEmail = emails[0].senderEmail;
  const title = FeedIdentityGetTitle(senderName, senderEmail);
  const feedUrlId = FeedIdentityGetFeedUrlId(id);

  const feed = new RSS({
    title,
    description: `Newsletter emails from ${title}`,
    feed_url: `${baseUrl}/rss/${feedUrlId}`,
    site_url: baseUrl,
    language: "en",
    ttl: FEED_TTL_MINUTES,
    custom_namespaces: {
      newsletter: "https://github.com/DidierHoarau/feedwatcher-newsletter/ns/1.0",
    },
  });

  for (const email of emails) {
    const sanitizedBody = HtmlSanitizerSanitize(email.body, stripTrackingPixels);
    feed.item({
      title: email.subject,
      description: HtmlSanitizerGetTextSummary(sanitizedBody),
      url: `${baseUrl}/view/${email.id}`,
      guid: email.id,
      date: email.dateReceived,
      custom_elements: [
        { "content:encoded": { _cdata: sanitizedBody } },
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
