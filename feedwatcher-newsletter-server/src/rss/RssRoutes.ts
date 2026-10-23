import { FastifyInstance, FastifyRequest } from "fastify";
import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelRequestSpan } from "../OTelContext";
import { Config } from "../Config";
import {
  EmailFeedsListAll,
  EmailsDataGetFeedLastModified,
  EmailsDataGetLastModified,
  FeedSummary,
} from "../emails/EmailsData";
import {
  FeedIdentityGetFeedUrlId,
  FeedIdentityResolveFeedUrlId,
} from "../feeds/FeedIdentity";
import { OpmlGeneratorBuild } from "../feeds/OpmlGenerator";
import { RssFeedGeneratorBuildFeedById } from "../emails/RssFeedGenerator";
import { HttpConditionalSend } from "./HttpConditional";
import { renderFeedsIndexPage } from "./HtmlPages";

const logger = OTelLogger().createModuleLogger("RssRoutes");

// Feed URLs use PUBLIC_URL when configured, otherwise the incoming request.
// request.host includes the port; request.protocol/request.host honour
// X-Forwarded-* only when Fastify trustProxy (TRUST_PROXY) is enabled. Without
// PUBLIC_URL the Host header is client-controlled (link poisoning).
function getBaseUrl(config: Config, request: FastifyRequest): string {
  const configured = (config.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  return configured || `${request.protocol}://${request.host}`;
}

interface FeedListEntry extends FeedSummary {
  feedUrl: string;
}

function getFeedsWithUrls(config: Config, request: FastifyRequest): {
  feeds: FeedListEntry[];
  baseUrl: string;
} {
  const baseUrl = getBaseUrl(config, request);
  const feeds = EmailFeedsListAll().map((feed) => ({
    ...feed,
    feedUrl: `${baseUrl}/rss/${FeedIdentityGetFeedUrlId(feed.feedId)}`,
  }));
  return { feeds, baseUrl };
}

export class RssRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    // List all available RSS feeds (one per sender). Browsers get a
    // human-readable index page, API clients keep the JSON array. Both
    // representations answer conditional requests and vary on Accept.
    fastify.get("/", async (request, reply) => {
      const { feeds } = getFeedsWithUrls(this.config, request);
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
            senderName: f.senderName,
            senderEmail: f.senderEmail,
            feedUrl: f.feedUrl,
          })),
        ),
        contentType: "application/json; charset=utf-8",
        lastModifiedMs,
        extraHeaders: { Vary: "Accept" },
      });
    });

    // OPML 2.0 export: one outline per feed, importable into FeedWatcher
    // and most RSS readers.
    fastify.get("/opml", async (request, reply) => {
      const { feeds, baseUrl } = getFeedsWithUrls(this.config, request);
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
    });

    // Get RSS feed for a specific sender by id. Ids may carry the private
    // token (<feedId>.<token>); bare feed ids keep working for existing
    // subscriptions unless strict private mode is enabled.
    fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
      const span = OTelRequestSpan(request) as Span;
      const { id } = request.params;
      const resolved = FeedIdentityResolveFeedUrlId(id);
      if (!resolved.valid) {
        logger.info(`Invalid feed token for id: ${id}`, span);
        reply.code(404);
        return reply.send({ error: "Feed not found" });
      }
      logger.info(`Generating RSS feed for id: ${resolved.feedId}`, span);

      const baseUrl = getBaseUrl(this.config, request);
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
    });
  };
}
