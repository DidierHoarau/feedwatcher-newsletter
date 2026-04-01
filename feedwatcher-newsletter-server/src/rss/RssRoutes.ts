import { FastifyInstance } from "fastify";
import { OTelLogger, OTelRequestSpan } from "../OTelContext";
import { EmailSendersListAll } from "../emails/EmailsData";
import { RssFeedGeneratorBuildFeedForSender } from "../emails/RssFeedGenerator";

const logger = OTelLogger().createModuleLogger("RssRoutes");

export class RssRoutes {
  public getRoutes = async (fastify: FastifyInstance) => {
    // List all available RSS feeds (one per sender)
    fastify.get("/", async (request, reply) => {
      const span = OTelRequestSpan(request);
      const senders = EmailSendersListAll();
      const baseUrl = `${request.protocol}://${request.hostname}`;
      const feeds = senders.map((s) => ({
        senderName: s.senderName,
        senderEmail: s.senderEmail,
        feedUrl: `${baseUrl}/rss/${encodeURIComponent(s.senderName)}`,
      }));
      return reply.send(feeds);
    });

    // Get RSS feed for a specific sender
    fastify.get<{ Params: { senderName: string } }>(
      "/:senderName",
      async (request, reply) => {
        const span = OTelRequestSpan(request);
        const { senderName } = request.params;
        const decodedSenderName = decodeURIComponent(senderName);
        logger.info(
          `Generating RSS feed for sender: ${decodedSenderName}`,
          span,
        );

        const baseUrl = `${request.protocol}://${request.hostname}`;
        const xml = RssFeedGeneratorBuildFeedForSender(
          span,
          decodedSenderName,
          baseUrl,
        );

        reply.header("Content-Type", "application/rss+xml; charset=utf-8");
        return reply.send(xml);
      },
    );
  };
}
