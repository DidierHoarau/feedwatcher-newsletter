import { FastifyInstance } from "fastify";
import { Config } from "../Config";
import { EmailsDataGetLastModified } from "../emails/EmailsData";
import { OTelRunWithRequestContext } from "../OTelContext";
import { HttpConditionalSend } from "../rss/HttpConditional";
import { ServerStatusGetFetchState } from "../ServerStatus";
import { HealthGet } from "../status/Health";
import { FeedCatalogueBuild, FeedCatalogueHealth } from "./FeedCatalogue";
import { FeedListingGetFeeds } from "./FeedListing";

// Versioned, machine-readable catalogue of the offered newsletter feeds.
// Registered inside the access-control scope, so it carries the same HTTP
// Basic protection as /rss/*.
export class FeedCatalogueRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    fastify.get("/api/feeds", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        const nowMs = Date.now();
        const { feeds } = FeedListingGetFeeds(this.config, request);
        const health = HealthGet(this.config, nowMs);
        const catalogueHealth: FeedCatalogueHealth = {
          status: health.status,
          staleAfterSeconds: health.staleAfterSeconds,
          quietAfterDays: health.quietAfterDays,
          lastSuccessfulFetchAt: health.lastSuccessfulFetchAt,
          idle: health.idle,
          lastError: health.lastError,
          storageFresh: health.storage.freshDataDirectory,
        };
        return HttpConditionalSend(request, reply, {
          body: FeedCatalogueBuild(feeds, catalogueHealth, nowMs),
          contentType: "application/json; charset=utf-8",
          // A fetch success/failure changes the health block even when no
          // email was stored, so it participates in the validator time.
          lastModifiedMs: Math.max(
            EmailsDataGetLastModified(),
            ServerStatusGetFetchState().lastChangeAtMs,
          ),
        });
      }),
    );
  };
}
