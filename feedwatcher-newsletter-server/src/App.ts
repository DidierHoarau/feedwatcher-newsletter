import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { StandardTracerFastifyRegisterHooks } from "@devopsplaybook.io/otel-utils-fastify";
import Fastify from "fastify";
import * as fse from "fs-extra";
import { Config } from "./Config";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { SchedulerInit, SchedulerReload } from "./Scheduler";
import { RssRoutes } from "./rss/RssRoutes";
import { ViewRoutes } from "./rss/ViewRoutes";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting FeedWatcher Newsletter Server ======");

Promise.resolve().then(async () => {
  //
  const config = new Config();
  await config.reload((msg) => logger.info(msg));

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");

  await SchedulerInit(span, config);

  span.end();

  // Hot configuration reload. ConfigBase.reload falls back to the defaults
  // when config.json is unreadable, so guard with a pre-parse: a missing or
  // half-written file keeps the last valid in-memory configuration instead
  // of resetting every file-based value. Registered after SchedulerInit so
  // the scheduler state exists; re-entrancy guard against poll overlaps.
  let reloading = false;
  fse.watchFile(config.CONFIG_FILE, async () => {
    if (reloading) return;
    reloading = true;
    try {
      try {
        await fse.readJson(config.CONFIG_FILE);
      } catch {
        logger.warn(
          `Ignoring config reload: ${config.CONFIG_FILE} is missing or invalid; keeping the last valid configuration`,
        );
        return;
      }
      logger.info(`Config updated: ${config.CONFIG_FILE}`);
      await config.reload((msg) => logger.info(msg));
      SchedulerReload(config);
      logger.info("Configuration reloaded and applied");
    } finally {
      reloading = false;
    }
  });

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
