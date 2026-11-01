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

export async function startServer(): Promise<void> {
  const logger = OTelLogger().createModuleLogger("app");

  logger.info("====== Starting FeedWatcher Newsletter Server ======");
  logger.info(
    `Process identity: uid=${typeof process.getuid === "function" ? process.getuid() : "n/a"} gid=${typeof process.getgid === "function" ? process.getgid() : "n/a"}`,
  );

  const config = new Config();
  await config.reload((msg) => logger.info(msg));

  OTelSetTracer(new StandardTracer(config));
  OTelSetMeter(new StandardMeter(config));
  OTelLogger().initOTel(config);

  const span = OTelTracer().startSpan("init");

  try {
    await SchedulerInit(span, config);
  } finally {
    span.end();
  }

  // Hot configuration reload. The file is re-read first: a missing or
  // half-written file keeps the last valid in-memory configuration instead of
  // resetting every file-based value. The reload itself is staged and atomic,
  // so a semantically invalid value rejects the whole file and leaves the
  // previous configuration untouched. Every error is caught and logged: the
  // watcher must never reject. Registered after SchedulerInit so the
  // scheduler state exists; re-entrancy guard against poll overlaps.
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
      await config.reloadAtomic((msg) => logger.info(msg));
      logger.info(`Config updated: ${config.CONFIG_FILE}`);
      try {
        SchedulerReload(config);
        logger.info("Configuration reloaded and applied");
      } catch (err) {
        logger.error(
          `Configuration reloaded but the scheduler update failed: ${(err as Error).message}`,
          err as Error,
        );
      }
    } catch (err) {
      logger.error(
        `Ignoring config reload: ${(err as Error).message}; keeping the last valid configuration`,
        err as Error,
      );
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
      return;
    }
    logger.info(`API Listening on port ${config.API_PORT}`);
  });
}

if (require.main === module) {
  void startServer();
}
