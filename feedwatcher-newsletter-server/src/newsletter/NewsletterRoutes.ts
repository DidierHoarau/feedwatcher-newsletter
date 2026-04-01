import { FastifyInstance } from "fastify";
import { OTelLogger, OTelRequestSpan } from "../OTelContext";
import {
  EmailItemsListById,
  EmailSendersListAll,
  EmailSenderGetId,
} from "../emails/EmailsData";

const logger = OTelLogger().createModuleLogger("NewsletterRoutes");

export class NewsletterRoutes {
  public getRoutes = async (fastify: FastifyInstance) => {
    // List all available newsletter feeds (one per sender)
    fastify.get("/", async (request, reply) => {
      const baseUrl = `${request.protocol}://${request.hostname}`;
      const senders = EmailSendersListAll();
      const feeds = senders.map((s) => ({
        id: EmailSenderGetId(s.senderName),
        senderName: s.senderName,
        senderEmail: s.senderEmail,
        feedUrl: `${baseUrl}/api/newsletter/${EmailSenderGetId(s.senderName)}`,
      }));
      return reply.status(200).send(feeds);
    });

    // Get newsletter emails for a specific sender by alphanumeric id
    fastify.get<{ Params: { id: string } }>("/:id", async (request, reply) => {
      const span = OTelRequestSpan(request);
      const { id } = request.params;
      logger.info(`Fetching newsletter for id: ${id}`, span);

      const emails = EmailItemsListById(id);
      return reply.status(200).send({ id, emails });
    });
  };
}
