import { FastifyInstance } from "fastify";
import { Config } from "../Config";
import { OTelLogger, OTelRequestSpan } from "../OTelContext";
import { EmailItemGetById } from "../emails/EmailsData";
import { renderViewPage } from "./HtmlPages";

const logger = OTelLogger().createModuleLogger("ViewRoutes");

// Readable permalink pages for individual emails, the link target of feed
// items.
export class ViewRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    fastify.get<{ Params: { emailId: string } }>(
      "/view/:emailId",
      async (request, reply) => {
        const span = OTelRequestSpan(request);
        const { emailId } = request.params;
        const email = EmailItemGetById(emailId);
        if (!email) {
          logger.info(`Email not found for view: ${emailId}`, span);
          reply.code(404);
          return reply.send({ error: "Email not found" });
        }
        reply.header("Content-Type", "text/html; charset=utf-8");
        return reply.send(
          renderViewPage(email, this.config.EMAIL_STRIP_TRACKING_PIXELS),
        );
      },
    );
  };
}
