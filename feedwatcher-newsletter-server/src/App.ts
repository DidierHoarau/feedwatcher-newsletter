import { StandardMeter, StandardTracer } from "@devopsplaybook.io/otel-utils";
import { FastifyInstance } from "fastify";
import * as fse from "fs-extra";
import { buildApp } from "./AppBuilder";
import { Config } from "./Config";
import {
  OTelLogger,
  OTelSetMeter,
  OTelSetTracer,
  OTelTracer,
} from "./OTelContext";
import { SchedulerInit, SchedulerReload, SchedulerStop } from "./Scheduler";

let fastifyInstance: FastifyInstance | undefined;
let watchedConfigFile: string | undefined;
let shutdownPromise: Promise<void> | undefined;
let shutdownRequested = false;
let shutdownHandlersRegistered = false;

// Stop accepting work and drain: cancel the scheduler, stop IMAP IDLE, close
// Fastify (no new requests, in-flight responses complete) and wait a bounded
// time for the in-flight fetch/purge/token write. Never rejects; repeated
// calls share one promise.
export function Shutdown(): Promise<void> {
  shutdownPromise ??= performShutdown();
  return shutdownPromise;
}

async function performShutdown(): Promise<void> {
  const logger = OTelLogger().createModuleLogger("app");
  try {
    logger.info("Shutdown requested: stopping the scheduler and draining the API");
    const schedulerStopped = SchedulerStop();
    if (watchedConfigFile) {
      fse.unwatchFile(watchedConfigFile);
    }
    try {
      await fastifyInstance?.close();
    } catch (err) {
      logger.error("Error closing the API", err as Error);
    }
    try {
      await schedulerStopped;
    } catch (err) {
      logger.error("Error stopping the scheduler", err as Error);
    }
    logger.info("Shutdown complete");
  } catch (err) {
    logger.error("Error during shutdown", err as Error);
  }
}

function registerShutdownHandlers(): void {
  if (shutdownHandlersRegistered) return;
  shutdownHandlersRegistered = true;
  const logger = OTelLogger().createModuleLogger("app");
  const onSignal = (signal: string): void => {
    if (shutdownRequested) {
      logger.warn(`${signal} received during shutdown: forcing exit`);
      process.exit(1);
      return;
    }
    shutdownRequested = true;
    logger.info(`${signal} received: shutting down gracefully`);
    void Shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));
}

export async function startServer(): Promise<void> {
  const logger = OTelLogger().createModuleLogger("app");
  shutdownPromise = undefined;
  shutdownRequested = false;

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
  watchedConfigFile = config.CONFIG_FILE;
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
  fastifyInstance = fastify;

  fastify.listen({ port: config.API_PORT, host: "0.0.0.0" }, (err) => {
    if (err) {
      logger.error("Error Starting API", err);
      process.exit(1);
      return;
    }
    logger.info(`API Listening on port ${config.API_PORT}`);
    registerShutdownHandlers();
  });
}

if (require.main === module) {
  void startServer();
}
