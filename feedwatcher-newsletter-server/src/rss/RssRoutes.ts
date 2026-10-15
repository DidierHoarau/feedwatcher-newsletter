import { FastifyInstance, FastifyRequest } from "fastify";
import { Span } from "@opentelemetry/sdk-trace-base";
import { OTelLogger, OTelRequestSpan } from "../OTelContext";
import { Config } from "../Config";
import {
  EmailFeedsListAll,
  FeedSummary,
} from "../emails/EmailsData";
import {
  FeedIdentityGetFeedUrlId,
  FeedIdentityResolveFeedUrlId,
} from "../feeds/FeedIdentity";
import { OpmlGeneratorBuild } from "../feeds/OpmlGenerator";
import { RssFeedGeneratorBuildFeedById } from "../emails/RssFeedGenerator";
import { renderFeedsIndexPage } from "./HtmlPages";

const logger = OTelLogger().createModuleLogger("RssRoutes");

// Feed URLs use PUBLIC_URL when configured, otherwise the incoming request.
function getBaseUrl(config: Config, request: FastifyRequest): string {
  return config.PUBLIC_URL || `${request.protocol}://${request.hostname}`;
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
    // human-readable index page, API clients keep the JSON array.
    fastify.get("/", async (request, reply) => {
      const { feeds } = getFeedsWithUrls(this.config, request);
      const accept = request.headers.accept || "";
      if (accept.includes("text/html")) {
        reply.header("Content-Type", "text/html; charset=utf-8");
        return reply.send(
          renderFeedsIndexPage(
            feeds.map((f) => ({
              feedUrl: f.feedUrl,
              title: f.title,
              senderName: f.senderName,
              senderEmail: f.senderEmail,
              itemCount: f.itemCount,
              latestDate: f.latestDate,
            })),
          ),
        );
      }
      return reply.send(
        feeds.map((f) => ({
          id: f.feedId,
          senderName: f.senderName,
          senderEmail: f.senderEmail,
          feedUrl: f.feedUrl,
        })),
      );
    });

    // OPML 2.0 export: one outline per feed, importable into FeedWatcher
    // and most RSS readers.
    fastify.get("/opml", async (request, reply) => {
      const { feeds, baseUrl } = getFeedsWithUrls(this.config, request);
      const xml = OpmlGeneratorBuild(
        "FeedWatcher Newsletter feeds",
        baseUrl,
        feeds,
      );
      reply.header("Content-Type", "text/x-opml; charset=utf-8");
      reply.header(
        "Content-Disposition",
        'attachment; filename="feedwatcher-newsletter.opml"',
      );
      return reply.send(xml);
    });

    // Get RSS feed for a specific sender by id. Ids may carry the private
    // token (<feedId>.<token>); bare feed ids keep working for existing
    // subscriptions.
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
      );

      reply.header("Content-Type", "application/rss+xml; charset=utf-8");
      return reply.send(xml);
    });
  };
}
