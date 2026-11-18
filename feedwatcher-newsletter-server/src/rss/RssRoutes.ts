import { FastifyInstance } from "fastify";
import { Span } from "@opentelemetry/api";
import {
  OTelLogger,
  OTelRequestSpan,
  OTelRunWithRequestContext,
} from "../OTelContext";
import { Config } from "../Config";
import {
  EmailsDataGetFeedLastModified,
  EmailsDataGetLastModified,
  EmailItemGetEffectiveDateReceived,
  EmailItemsListById,
} from "../emails/EmailsData";
import { SanitizedBodyCacheGet } from "../emails/SanitizedBodyCache";
import {
  FeedIdentityGetFeedUrlId,
  FeedIdentityGetTitle,
  FeedIdentityResolveFeedUrlId,
} from "../feeds/FeedIdentity";
import {
  FeedSettingsGetBlockRemoteImages,
  FeedSettingsGetForFeed,
  FeedSettingsGetMaxItems,
  FeedSettingsGetStripTrackingPixels,
  FeedSettingsIsHidden,
  FeedSettingsResolveMergeTarget,
} from "../feeds/FeedSettings";
import {
  FeedListingFilter,
  FeedListingGetBaseUrl,
  FeedListingGetFeeds,
  FeedListingGetPreview,
  FeedListingNormalizeQuery,
  FeedListingServedItemCount,
  FeedListingSortByRecent,
} from "../feeds/FeedListing";
import { OpmlGeneratorBuild } from "../feeds/OpmlGenerator";
import { RssFeedGeneratorBuildFeedById } from "../emails/RssFeedGenerator";
import { ServerStatusGetFetchState } from "../ServerStatus";
import { FeedActivityIsQuiet } from "../status/FeedActivity";
import {
  HealthBannerMessage,
  HealthGet,
  HealthNeedsBanner,
} from "../status/Health";
import { HttpConditionalSend } from "./HttpConditional";
import { renderFeedArchivePage, renderFeedsIndexPage } from "./HtmlPages";

const logger = OTelLogger().createModuleLogger("RssRoutes");

export class RssRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    // List all available RSS feeds (one per sender). Browsers get a
    // human-readable index page, API clients keep the JSON array. Both
    // representations answer conditional requests and vary on Accept.
    fastify.get("/", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        const { feeds } = FeedListingGetFeeds(this.config, request);
        const accept = request.headers.accept || "";
        const lastModifiedMs = EmailsDataGetLastModified();
        if (accept.includes("text/html")) {
          const nowMs = Date.now();
          const query = FeedListingNormalizeQuery(
            (request.query as { q?: unknown } | undefined)?.q,
          );
          const visible = FeedListingSortByRecent(
            FeedListingFilter(feeds, query),
          );
          const health = HealthGet(this.config, nowMs);
          const banner = HealthNeedsBanner(health)
            ? HealthBannerMessage(health)
            : undefined;
          return HttpConditionalSend(request, reply, {
            body: renderFeedsIndexPage(
              visible.map((f) => ({
                feedUrl: f.feedUrl,
                archiveUrl: f.archiveUrl,
                title: f.title,
                senderName: f.senderName,
                senderEmail: f.senderEmail,
                itemCount: f.itemCount,
                servedItemCount: f.servedItemCount,
                latestDate: f.latestDate,
                quiet: FeedActivityIsQuiet(f.latestDate, nowMs),
                preview: FeedListingGetPreview(f.feedId, this.config),
              })),
              { query, totalCount: feeds.length, banner },
            ),
            contentType: "text/html; charset=utf-8",
            // The banner depends on the fetch state even when no email was
            // stored, so the health change participates in the validators.
            lastModifiedMs: Math.max(
              lastModifiedMs,
              ServerStatusGetFetchState().lastChangeAtMs,
            ),
            extraHeaders: { Vary: "Accept" },
          });
        }
        return HttpConditionalSend(request, reply, {
          body: JSON.stringify(
            feeds.map((f) => ({
              id: f.feedId,
              feedId: f.feedId,
              title: f.title,
              senderName: f.senderName,
              senderEmail: f.senderEmail,
              itemCount: f.itemCount,
              latestDate: f.latestDate,
              feedUrl: f.feedUrl,
            })),
          ),
          contentType: "application/json; charset=utf-8",
          lastModifiedMs,
          extraHeaders: { Vary: "Accept" },
        });
      }),
    );

    // OPML 2.0 export: one outline per feed, grouped under a Newsletters
    // folder, importable into FeedWatcher and most RSS readers.
    fastify.get("/opml", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        const { feeds, baseUrl } = FeedListingGetFeeds(this.config, request);
        const lastModifiedMs = EmailsDataGetLastModified();
        const xml = OpmlGeneratorBuild(
          "FeedWatcher Newsletter feeds",
          baseUrl,
          feeds,
          new Date(lastModifiedMs || Date.now()),
        );
        return HttpConditionalSend(request, reply, {
          body: xml,
          contentType: "text/x-opml; charset=utf-8",
          lastModifiedMs,
          extraHeaders: {
            "Content-Disposition":
              'attachment; filename="feedwatcher-newsletter.opml"',
          },
        });
      }),
    );

    // Get RSS feed for a specific sender by id. Ids may carry the private
    // token (<feedId>.<token>); bare feed ids keep working for existing
    // subscriptions unless strict private mode is enabled.
    fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        const span = OTelRequestSpan(request) as Span;
        const { id } = request.params;
        const resolved = FeedIdentityResolveFeedUrlId(id);
        if (!resolved.valid) {
          // Never log the URL id: it may carry a feed token.
          logger.info(`Invalid feed token for feed: ${resolved.feedId}`, span);
          reply.code(404);
          return reply.send({ error: "Feed not found" });
        }
        // Hidden is a read-path curation: the journal record and the token are
        // untouched, so unhiding restores the same feed.
        if (FeedSettingsIsHidden(resolved.feedId)) {
          logger.info(`Hidden feed id: ${resolved.feedId}`, span);
          reply.code(404);
          return reply.send({ error: "Feed not found" });
        }
        const finalFeedId = FeedSettingsResolveMergeTarget(resolved.feedId);
        if (finalFeedId !== resolved.feedId) {
          if (FeedSettingsIsHidden(finalFeedId)) {
            logger.info(
              `Feed ${resolved.feedId} merges into hidden feed ${finalFeedId}`,
              span,
            );
            reply.code(404);
            return reply.send({ error: "Feed not found" });
          }
          // Readers holding a merged source token are redirected to the target
          // feed with its own capability token.
          reply.code(302);
          reply.header(
            "Location",
            `/rss/${FeedIdentityGetFeedUrlId(finalFeedId)}`,
          );
          return reply.send();
        }

        const baseUrl = FeedListingGetBaseUrl(this.config, request);
        const xml = RssFeedGeneratorBuildFeedById(
          span,
          finalFeedId,
          baseUrl,
          FeedSettingsGetStripTrackingPixels(
            finalFeedId,
            this.config.EMAIL_STRIP_TRACKING_PIXELS,
          ),
          FeedSettingsGetBlockRemoteImages(
            finalFeedId,
            this.config.EMAIL_BLOCK_REMOTE_IMAGES,
          ),
          FeedSettingsGetMaxItems(finalFeedId, this.config.FEED_MAX_ITEMS),
        );
        if (xml === undefined) {
          logger.info(`Unknown feed id: ${finalFeedId}`, span);
          reply.code(404);
          return reply.send({ error: "Feed not found" });
        }

        return HttpConditionalSend(request, reply, {
          body: xml,
          contentType: "application/rss+xml; charset=utf-8",
          lastModifiedMs: EmailsDataGetFeedLastModified(finalFeedId),
        });
      }),
    );

    // Per-feed HTML archive: every retained email, newest first, with the same
    // auth scope and token rules as the feed. The RSS feed is the capped window.
    fastify.get<{ Params: { id: string } }>("/:id/archive", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        const span = OTelRequestSpan(request) as Span;
        const resolved = FeedIdentityResolveFeedUrlId(request.params.id);
        if (!resolved.valid) {
          // Never log the URL id: it may carry a feed token.
          logger.info(`Invalid feed token for feed: ${resolved.feedId}`, span);
          reply.code(404);
          return reply.send({ error: "Feed not found" });
        }
        if (FeedSettingsIsHidden(resolved.feedId)) {
          logger.info(`Hidden feed id: ${resolved.feedId}`, span);
          reply.code(404);
          return reply.send({ error: "Feed not found" });
        }
        const finalFeedId = FeedSettingsResolveMergeTarget(resolved.feedId);
        if (finalFeedId !== resolved.feedId) {
          if (FeedSettingsIsHidden(finalFeedId)) {
            logger.info(
              `Feed ${resolved.feedId} merges into hidden feed ${finalFeedId}`,
              span,
            );
            reply.code(404);
            return reply.send({ error: "Feed not found" });
          }
          reply.code(302);
          reply.header(
            "Location",
            `/rss/${FeedIdentityGetFeedUrlId(finalFeedId)}/archive`,
          );
          return reply.send();
        }
        const items = EmailItemsListById(finalFeedId);
        if (items.length === 0) {
          logger.info(`Unknown feed id: ${finalFeedId}`, span);
          reply.code(404);
          return reply.send({ error: "Feed not found" });
        }
        const baseUrl = FeedListingGetBaseUrl(this.config, request);
        const feedUrl = `${baseUrl}/rss/${FeedIdentityGetFeedUrlId(finalFeedId)}`;
        const stripTrackingPixels = FeedSettingsGetStripTrackingPixels(
          finalFeedId,
          this.config.EMAIL_STRIP_TRACKING_PIXELS,
        );
        const blockRemoteImages = FeedSettingsGetBlockRemoteImages(
          finalFeedId,
          this.config.EMAIL_BLOCK_REMOTE_IMAGES,
        );
        const archiveItems = items.map((item) => ({
          id: item.id,
          subject: item.subject,
          date: EmailItemGetEffectiveDateReceived(item),
          senderName: item.senderName,
          senderEmail: item.senderEmail,
          summary: SanitizedBodyCacheGet(
            item,
            stripTrackingPixels,
            blockRemoteImages,
          ).summary,
        }));
        return HttpConditionalSend(request, reply, {
          body: renderFeedArchivePage(
            {
              title:
                FeedSettingsGetForFeed(finalFeedId)?.title ??
                FeedIdentityGetTitle(
                  items[0].senderName,
                  items[0].senderEmail,
                ),
              feedUrl,
              archiveUrl: `${feedUrl}/archive`,
            },
            archiveItems,
            FeedListingServedItemCount(
              FeedSettingsGetMaxItems(finalFeedId, this.config.FEED_MAX_ITEMS),
              items.length,
            ),
          ),
          contentType: "text/html; charset=utf-8",
          lastModifiedMs: EmailsDataGetFeedLastModified(finalFeedId),
        });
      }),
    );
  };
}
