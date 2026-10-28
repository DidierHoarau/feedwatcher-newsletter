import { FastifyInstance } from "fastify";
import { Span } from "@opentelemetry/sdk-trace-base";
import {
  OTelLogger,
  OTelRequestSpan,
  OTelRunWithRequestContext,
} from "../OTelContext";
import { Config } from "../Config";
import {
  EmailsDataGetFeedLastModified,
  EmailsDataGetLastModified,
} from "../emails/EmailsData";
import { FeedIdentityResolveFeedUrlId } from "../feeds/FeedIdentity";
import { FeedListingGetBaseUrl, FeedListingGetFeeds } from "../feeds/FeedListing";
import { OpmlGeneratorBuild } from "../feeds/OpmlGenerator";
import { RssFeedGeneratorBuildFeedById } from "../emails/RssFeedGenerator";
import { HttpConditionalSend } from "./HttpConditional";
import { renderFeedsIndexPage } from "./HtmlPages";

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
          return HttpConditionalSend(request, reply, {
            body: renderFeedsIndexPage(
              feeds.map((f) => ({
                feedUrl: f.feedUrl,
                title: f.title,
                senderName: f.senderName,
                senderEmail: f.senderEmail,
                itemCount: f.itemCount,
                latestDate: f.latestDate,
              })),
            ),
            contentType: "text/html; charset=utf-8",
            lastModifiedMs,
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

        const baseUrl = FeedListingGetBaseUrl(this.config, request);
        const xml = RssFeedGeneratorBuildFeedById(
          span,
          resolved.feedId,
          baseUrl,
          this.config.EMAIL_STRIP_TRACKING_PIXELS,
        );
        if (xml === undefined) {
          logger.info(`Unknown feed id: ${resolved.feedId}`, span);
          reply.code(404);
          return reply.send({ error: "Feed not found" });
        }

        return HttpConditionalSend(request, reply, {
          body: xml,
          contentType: "application/rss+xml; charset=utf-8",
          lastModifiedMs: EmailsDataGetFeedLastModified(resolved.feedId),
        });
      }),
    );
  };
}
