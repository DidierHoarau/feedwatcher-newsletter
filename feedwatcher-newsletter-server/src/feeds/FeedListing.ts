import { FastifyRequest } from "fastify";
import { Config } from "../Config";
import {
  EmailFeedsListAll,
  EmailItemGetEffectiveDateReceived,
  EmailItemsListById,
  FeedSummary,
} from "../emails/EmailsData";
import { SanitizedBodyCacheGet } from "../emails/SanitizedBodyCache";
import { FeedIdentityGetFeedUrlId } from "./FeedIdentity";
import {
  FeedSettingsGetBlockRemoteImages,
  FeedSettingsGetMaxItems,
  FeedSettingsGetStripTrackingPixels,
} from "./FeedSettings";

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
  archiveUrl: string;
  servedItemCount: number;
}

// The feed is the bounded "recent" window: it serves at most the effective
// maxItems emails (per-feed setting, else FEED_MAX_ITEMS), while retention and
// the archive keep every stored email.
export function FeedListingServedItemCount(
  maxItems: number,
  itemCount: number,
): number {
  return maxItems > 0 ? Math.min(itemCount, maxItems) : itemCount;
}

export function FeedListingGetFeeds(
  config: Config,
  request: FastifyRequest,
): { feeds: FeedListEntry[]; baseUrl: string } {
  const baseUrl = FeedListingGetBaseUrl(config, request);
  const feeds = EmailFeedsListAll().map((feed) => {
    const feedUrl = `${baseUrl}/rss/${FeedIdentityGetFeedUrlId(feed.feedId)}`;
    return {
      ...feed,
      feedUrl,
      archiveUrl: `${feedUrl}/archive`,
      servedItemCount: FeedListingServedItemCount(
        FeedSettingsGetMaxItems(feed.feedId, config.FEED_MAX_ITEMS),
        feed.itemCount,
      ),
    };
  });
  return { feeds, baseUrl };
}

// The human index is server-rendered and works without JavaScript: the text
// filter is a plain GET form handled here, capped so a huge query cannot bloat
// the page or the logs.
export function FeedListingNormalizeQuery(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 200) : "";
}

export interface FeedListingFilterable {
  title: string;
  senderName: string;
  senderEmail: string;
  feedId: string;
}

export function FeedListingFilter<T extends FeedListingFilterable>(
  feeds: T[],
  query: string,
): T[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") {
    return feeds.slice();
  }
  return feeds.filter((feed) =>
    [feed.title, feed.senderName, feed.senderEmail, feed.feedId].some((value) =>
      (value || "").toLowerCase().includes(needle),
    ),
  );
}

// Most recently active feeds first. Invalid dates sort last; equal dates fall
// back to the catalogue order so the page stays deterministic.
export function FeedListingSortByRecent<
  T extends { latestDate: string; title: string; feedId: string },
>(feeds: T[]): T[] {
  return feeds.slice().sort((a, b) => {
    const aMs = Date.parse(a.latestDate);
    const bMs = Date.parse(b.latestDate);
    const aValid = Number.isFinite(aMs);
    const bValid = Number.isFinite(bMs);
    if (aValid && bValid) {
      if (aMs !== bMs) {
        return bMs - aMs;
      }
    } else if (aValid !== bValid) {
      return aValid ? -1 : 1;
    }
    return a.title.localeCompare(b.title) || a.feedId.localeCompare(b.feedId);
  });
}

export interface FeedPreviewItem {
  id: string;
  subject: string;
  date: string;
  summary: string;
}

// Newest items of one feed for the index. It is deliberately a preview, not
// the archive: at most FEED_INDEX_PREVIEW_ITEMS per feed keeps the page small
// for 30 feeds, and summaries come from the shared sanitized-body cache.
export const FEED_INDEX_PREVIEW_ITEMS = 2;

export function FeedListingGetPreview(
  feedId: string,
  config: Config,
  limit: number = FEED_INDEX_PREVIEW_ITEMS,
): FeedPreviewItem[] {
  const stripTrackingPixels = FeedSettingsGetStripTrackingPixels(
    feedId,
    config.EMAIL_STRIP_TRACKING_PIXELS,
  );
  const blockRemoteImages = FeedSettingsGetBlockRemoteImages(
    feedId,
    config.EMAIL_BLOCK_REMOTE_IMAGES,
  );
  return EmailItemsListById(feedId)
    .slice(0, Math.max(0, limit))
    .map((item) => ({
      id: item.id,
      subject: item.subject,
      date: EmailItemGetEffectiveDateReceived(item),
      summary: SanitizedBodyCacheGet(
        item,
        stripTrackingPixels,
        blockRemoteImages,
      ).summary,
    }));
}
