import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import * as fse from "fs-extra";
import { buildApp } from "./AppBuilder";
import { Config } from "./Config";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { SchedulerInit, SchedulerReload } from "./Scheduler";

const logger = OTelLogger().createModuleLogger("app");

logger.info("====== Starting FeedWatcher Newsletter Server ======");
logger.info(
  `Process identity: uid=${typeof process.getuid === "function" ? process.getuid() : "n/a"} gid=${typeof process.getgid === "function" ? process.getgid() : "n/a"}`,
);

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

  const fastify = buildApp(config);

  fastify.listen({ port: config.API_PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      logger.error("Error Starting API", err);
      process.exit(1);
    }
    logger.info(`API Listening on port ${config.API_PORT}`);
  });
});
