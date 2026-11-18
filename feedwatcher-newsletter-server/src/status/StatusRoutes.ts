import { FastifyInstance } from "fastify";
import { Config } from "../Config";
import { OTelRunWithRequestContext } from "../OTelContext";
import { ServerStatusGet } from "../ServerStatus";
import { renderStatusPage } from "../rss/HtmlPages";
import { HealthGet } from "./Health";

// Human ingestion status page, registered inside the access-control scope:
// with AUTH_PASSWORD set it needs the same Basic credentials as /rss/. The
// machine-readable /api/status stays open for probes and unchanged.
export class StatusRoutes {
  constructor(private config: Config) {}

  public getRoutes = async (fastify: FastifyInstance) => {
    fastify.get("/status", async (request, reply) =>
      OTelRunWithRequestContext(request, async () => {
        const nowMs = Date.now();
        // The age and the derived status are time-dependent: no validators,
        // never cache.
        reply.header("Cache-Control", "no-store");
        reply.header("Content-Type", "text/html; charset=utf-8");
        return reply.send(
          renderStatusPage({
            serverStatus: ServerStatusGet(),
            health: HealthGet(this.config, nowMs),
            cron: this.config.EMAIL_FETCH_CRON,
          }),
        );
      }),
    );
  };
}
