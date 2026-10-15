import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify from "fastify";
import { watchFile } from "fs-extra";
import { Config } from "./Config";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { SchedulerInit } from "./Scheduler";
import { RssRoutes } from "./rss/RssRoutes";
import { ViewRoutes } from "./rss/ViewRoutes";
import { FeedIdentityInit } from "./feeds/FeedIdentity";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting FeedWatcher Newsletter Server ======");

Promise.resolve().then(async () => {
  //
  const config = new Config();
  await config.reload((msg) => logger.info(msg));
  watchFile(config.CONFIG_FILE, () => {
    logger.info(`Config updated: ${config.CONFIG_FILE}`);
    config.reload((msg) => logger.info(msg)).then(() => {
      FeedIdentityInit({
        ignoreList: config.SENDER_IGNORE_LIST,
        overrides: config.FEED_OVERRIDES,
        privateUrls: config.FEED_PRIVATE_URLS,
        dataDir: config.DATA_DIR,
      });
    });
  });

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");

  await SchedulerInit(span, config);

  span.end();

  // API

  const fastify = Fastify({});

  StandardTracerFastifyRegisterHooks(fastify, OTelTracer(), OTelLogger(), {
    ignoreList: ["GET-/api/status"],
  });

  fastify.get("/api/status", async () => {
    return { started: true };
  });

  // Human entry point: the feeds index page
  fastify.get("/", async (_request, reply) => {
    return reply.redirect("/rss/");
  });

  // Readable permalink pages for individual emails
  fastify.register(new ViewRoutes().getRoutes);

  fastify.register(new RssRoutes(config).getRoutes, {
    prefix: "/rss",
  });

  fastify.listen({ port: config.API_PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      logger.error("Error Starting API", err);
      process.exit(1);
    }
    logger.info(`API Listening on port ${config.API_PORT}`);
  });
});
