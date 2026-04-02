import { FastifyInstance } from "fastify";
import { OTelLogger, OTelRequestSpan } from "../OTelContext";
import { EmailSendersListAll, EmailSenderGetId } from "../emails/EmailsData";
import { RssFeedGeneratorBuildFeedById } from "../emails/RssFeedGenerator";

const logger = OTelLogger().createModuleLogger("RssRoutes");

export class RssRoutes {
  public getRoutes = async (fastify: FastifyInstance) => {
    // List all available RSS feeds (one per sender)
    fastify.get("/", async (request, reply) => {
      const span = OTelRequestSpan(request);
      const senders = EmailSendersListAll();
      const baseUrl = `${request.protocol}://${request.hostname}`;
      const feeds = senders.map((s) => ({
        id: EmailSenderGetId(s.senderName),
        senderName: s.senderName,
        senderEmail: s.senderEmail,
        feedUrl: `${baseUrl}/rss/${EmailSenderGetId(s.senderName)}`,
      }));
      return reply.send(feeds);
    });

    // Get RSS feed for a specific sender by id
    fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
      const span = OTelRequestSpan(request);
      const { id } = request.params;
      logger.info(`Generating RSS feed for id: ${id}`, span);

      const baseUrl = `${request.protocol}://${request.hostname}`;
      const xml = RssFeedGeneratorBuildFeedById(span, id, baseUrl);

      reply.header("Content-Type", "application/rss+xml; charset=utf-8");
      return reply.send(xml);
    });
  };
}
