import { FastifyRequest } from "fastify";
import { Config } from "../Config";
import { EmailFeedsListAll, FeedSummary } from "../emails/EmailsData";
import { FeedIdentityGetFeedUrlId } from "./FeedIdentity";

// Feed URLs use PUBLIC_URL when configured, otherwise the incoming request.
// request.host includes the port; request.protocol/request.host honour
// X-Forwarded-* only when Fastify trustProxy (TRUST_PROXY) is enabled. Without
// PUBLIC_URL the Host header is client-controlled (link poisoning).
export function FeedListingGetBaseUrl(
  config: Config,
  request: FastifyRequest,
): string {
  const configured = (config.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  return configured || `${request.protocol}://${request.host}`;
}

export interface FeedListEntry extends FeedSummary {
  feedUrl: string;
}

export function FeedListingGetFeeds(
  config: Config,
  request: FastifyRequest,
): { feeds: FeedListEntry[]; baseUrl: string } {
  const baseUrl = FeedListingGetBaseUrl(config, request);
  const feeds = EmailFeedsListAll().map((feed) => ({
    ...feed,
    feedUrl: `${baseUrl}/rss/${FeedIdentityGetFeedUrlId(feed.feedId)}`,
  }));
  return { feeds, baseUrl };
}
