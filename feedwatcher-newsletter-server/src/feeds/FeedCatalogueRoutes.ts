import { FastifyInstance } from "fastify";
import { Config } from "../Config";
import { EmailsDataGetLastModified } from "../emails/EmailsData";
import { OTelRunWithRequestContext } from "../OTelContext";
import { HttpConditionalSend } from "../rss/HttpConditional";
import { FeedCatalogueBuild } from "./FeedCatalogue";
import { FeedListingGetFeeds } from "./FeedListing";

// Versioned, machine-readable catalogue of the offered newsletter feeds.
// Registered inside the access-control scope, so it carries the same HTTP
// Basic protection as /rss/*.
export class FeedCatalogueRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    fastify.get("/api/feeds", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        const { feeds } = FeedListingGetFeeds(this.config, request);
        return HttpConditionalSend(request, reply, {
          body: FeedCatalogueBuild(feeds),
          contentType: "application/json; charset=utf-8",
          lastModifiedMs: EmailsDataGetLastModified(),
        });
      }),
    );
  };
}
