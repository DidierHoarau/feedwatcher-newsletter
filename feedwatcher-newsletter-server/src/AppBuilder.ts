import Fastify, { FastifyInstance } from "fastify";
import compress from "@fastify/compress";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import { Config } from "./Config";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { RssRoutes } from "./rss/RssRoutes";
import { ViewRoutes } from "./rss/ViewRoutes";
import { AccessControlRegisterHook } from "./security/AccessControl";

export function buildApp(config: Config): FastifyInstance {
  const fastify = Fastify({ trustProxy: config.TRUST_PROXY });

  // gzip/brotli negotiation for feed payloads and HTML pages. The 1 KiB
  // threshold keeps tiny payloads (status, errors) identity-encoded, and a
  // request without Accept-Encoding gets the identity representation.
  fastify.register(compress, { threshold: 1024 });

  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    ignoreList: ["GET-/api/status"],
  });

  fastify.get("/api/status", async () => ({ started: true }));

  // The access-control hook is registered on this encapsulated scope, so it
  // protects /, /rss/* and /view/* while /api/status stays open for probes.
  fastify.register(async (scope) => {
    AccessControlRegisterHook(scope, config);
    scope.get("/", async (_request, reply) => reply.redirect("/rss/"));
    scope.register(new ViewRoutes(config).getRoutes);
    scope.register(new RssRoutes(config).getRoutes, { prefix: "/rss" });
  });

  return fastify;
}
