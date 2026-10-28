import Fastify, { FastifyInstance } from "fastify";
import compress from "@fastify/compress";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import { Config } from "./Config";
import { OTelLogger, OTelTracer } from "./OTelContext";
import { RssRoutes } from "./rss/RssRoutes";
import { SecurityHeadersRegisterHook } from "./rss/SecurityHeaders";
import { ViewRoutes } from "./rss/ViewRoutes";
import { AccessControlRegisterHook } from "./security/AccessControl";
import { ServerStatusGet } from "./ServerStatus";
import { FeedCatalogueRoutes } from "./feeds/FeedCatalogueRoutes";

export function buildApp(config: Config): FastifyInstance {
  const fastify = Fastify({ trustProxy: config.TRUST_PROXY });

  // Security headers are registered before the routes so every response,
  // including /api/status, carries them.
  SecurityHeadersRegisterHook(fastify);

  // gzip/brotli negotiation for feed payloads and HTML pages. The 1 KiB
  // threshold keeps tiny payloads (status, errors) identity-encoded, and a
  // request without Accept-Encoding gets the identity representation.
  fastify.register(compress, { threshold: 1024 });

  // Product routes live under / and /rss, /view, so trace the whole tree.
  // /api/status is polled by the readiness probe and stays untraced.
  // standardMeter is deliberately not passed: no metrics are emitted.
  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    rootApiPath: "/",
    ignoreList: ["GET-/api/status"],
    unmatchedRouteSpanName: "method",
  });

  fastify.get("/api/status", async () => ServerStatusGet());

  // The access-control hook is registered on this encapsulated scope, so it
  // protects /, /rss/*, /view/* and /api/feeds while /api/status stays open
  // for probes.
  fastify.register(async (scope) => {
    AccessControlRegisterHook(scope, config);
    scope.get("/", async (_request, reply) => reply.redirect("/rss/"));
    scope.register(new ViewRoutes(config).getRoutes);
    scope.register(new RssRoutes(config).getRoutes, { prefix: "/rss" });
    scope.register(new FeedCatalogueRoutes(config).getRoutes);
  });

  return fastify;
}
