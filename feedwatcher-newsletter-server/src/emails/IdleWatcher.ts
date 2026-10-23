import Imap from "imap";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("IdleWatcher");

// Debounce: a burst of incoming mail triggers one fetch, not one per message.
const FETCH_DEBOUNCE_MS = 10000;
const RECONNECT_BASE_DELAY_MS = 30000;
const RECONNECT_MAX_DELAY_MS = 600000;

let config: Config;
let triggerFetch: () => void;
let running = false;
let reconnectDelay = RECONNECT_BASE_DELAY_MS;
let debounceTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let connection: Imap | undefined;
// Functions as a fence for stale connection events: after a stop or a
// reconnect, handlers of an old socket must not schedule fetches or open
// another connection on top of the current one.
let generation = 0;

// Keep a long-lived IMAP connection for near-real-time ingestion: the server
// notifies new mail and the standard fetch flow runs on its own connection.
// The cron schedule remains as fallback; this is an additional trigger.
export function IdleWatcherStart(
  configIn: Config,
  triggerFetchIn: () => void,
): void {
  config = configIn;
  triggerFetch = triggerFetchIn;
  if (!config.EMAIL_FETCH_IDLE) {
    logger.info("IMAP IDLE disabled (EMAIL_FETCH_IDLE=false)");
    IdleWatcherStop();
    return;
  }
  if (running) {
    // Idempotent: keep the existing connection, only the callbacks/config
    // were refreshed.
    return;
  }
  running = true;
  connect();
}

export function IdleWatcherStop(): void {
  running = false;
  generation++;
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
  }
  if (connection) {
    connection.destroy();
    connection = undefined;
  }
  reconnectDelay = RECONNECT_BASE_DELAY_MS;
}

function connect(): void {
  if (!running) return;
  const connectionGeneration = ++generation;
  logger.info(
    `Opening IMAP IDLE connection to ${config.IMAP_HOST}:${config.IMAP_PORT}`,
  );
  const imap = new Imap({
    user: config.IMAP_USER,
    password: config.IMAP_PASSWORD,
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    tls: config.IMAP_TLS,
    tlsOptions: { rejectUnauthorized: false },
    // Must exceed node-imap's 300 s IDLE re-send interval, otherwise the
    // socket timeout would kill a healthy idle connection.
    socketTimeout: config.IMAP_IDLE_SOCKET_TIMEOUT_MS,
  } as Imap.Config & { socketTimeout: number });
  connection = imap;

  imap.once("ready", () => {
    if (connectionGeneration !== generation) return;
    reconnectDelay = RECONNECT_BASE_DELAY_MS;
    imap.openBox(config.IMAP_MAILBOX, true, (err) => {
      if (connectionGeneration !== generation) return;
      if (err) {
        logger.error(`Error opening mailbox for IDLE`, err);
        // destroy() closes the socket and triggers the close handler below,
        // which schedules the reconnect.
        imap.destroy();
        return;
      }
      logger.info("IMAP IDLE listening for new mail");
      imap.on("mail", (numNewMail: number) => {
        if (connectionGeneration !== generation) return;
        logger.info(`IMAP IDLE: ${numNewMail} new mail(s) detected`);
        scheduleFetch();
      });
    });
  });

  imap.once("error", (err) => {
    if (connectionGeneration !== generation) return;
    logger.error(`IMAP IDLE connection error`, err);
    imap.destroy();
  });

  imap.once("close", (hadError: boolean) => {
    if (connectionGeneration !== generation) return;
    logger.info(`IMAP IDLE connection closed (error: ${hadError})`);
    connection = undefined;
    scheduleReconnect();
  });

  imap.connect();
}

function scheduleReconnect(): void {
  if (!running) return;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  const delay = reconnectDelay;
  logger.info(
    `Reconnecting IMAP IDLE in ${Math.round(delay / 1000)}s`,
  );
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    connect();
  }, delay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
}

function scheduleFetch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = undefined;
    triggerFetch();
  }, FETCH_DEBOUNCE_MS);
}
