import RSS from "rss";
import { Span } from "@opentelemetry/api";
import { OTelTracer } from "../OTelContext";
import { FeedIdentityGetFeedUrlId, FeedIdentityGetTitle } from "../feeds/FeedIdentity";
import { EmailItemsListById, EmailsDataGetFeedLastModified, EmailItemGetEffectiveDateReceived } from "./EmailsData";
import { SanitizedBodyCacheGet } from "./SanitizedBodyCache";

const FEED_TTL_MINUTES = 60;

export function RssFeedGeneratorBuildFeedById(
  context: Span,
  id: string,
  baseUrl: string,
  stripTrackingPixels = true,
): string | undefined {
  const span = OTelTracer().startSpan("RssFeedGeneratorBuildFeedById", context);
  try {
    const emails = EmailItemsListById(id);
    // An unknown (or ignored) feed has no emails: do not advertise it or create
    // a token for it.
    if (emails.length === 0) {
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
      const sanitizedBody = SanitizedBodyCacheGet(email, stripTrackingPixels);
      feed.item({
        title: email.subject,
        description: sanitizedBody.summary,
        url: `${baseUrl}/view/${email.id}`,
        guid: email.id,
        // The item date uses the clamped effective date: a future Date header
        // must not surface as a future <pubDate>. newsletter:dateReceived keeps
        // the stored value for provenance.
        date: EmailItemGetEffectiveDateReceived(email),
        custom_elements: [
          { "content:encoded": { _cdata: sanitizedBody.html } },
          { "newsletter:messageId": email.messageId },
          { "newsletter:senderName": email.senderName },
          { "newsletter:senderEmail": email.senderEmail },
          { "newsletter:dateReceived": email.dateReceived },
          { "newsletter:dateCreated": email.dateCreated },
        ],
      });
    }

    // rss stamps <lastBuildDate> with the wall clock on every build, which would
    // change the document (and its ETag) on every request. Use the feed's
    // content/mutation timestamp so unchanged data yields an identical document.
    const xml = feed.xml({ indent: true });
    const lastBuildDate = new Date(
      EmailsDataGetFeedLastModified(id),
    ).toUTCString();
    return xml.replace(
      /<lastBuildDate>[^<]*<\/lastBuildDate>/,
      `<lastBuildDate>${lastBuildDate}</lastBuildDate>`,
    );
  } finally {
    span.end();
  }
}
