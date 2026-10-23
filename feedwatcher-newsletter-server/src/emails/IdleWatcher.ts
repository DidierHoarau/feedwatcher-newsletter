import { ImapFlow } from "imapflow";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";
import {
  BuildImapFlowOptions,
  ImapLogConnectionError,
  ImapLogConnectionEstablished,
} from "./ImapConnection";

const logger = OTelLogger().createModuleLogger("IdleWatcher");

// Debounce: a burst of incoming mail triggers one fetch, not one per message.
const FETCH_DEBOUNCE_MS = 10000;
const RECONNECT_BASE_DELAY_MS = 30000;
const RECONNECT_MAX_DELAY_MS = 600000;

let config: Config;
let triggerFetch: () => void;
let running = false;
let connected = false;
let reconnectDelay = RECONNECT_BASE_DELAY_MS;
let debounceTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let connection: ImapFlow | undefined;
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
  connected = false;
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
    connection.close();
    connection = undefined;
  }
  reconnectDelay = RECONNECT_BASE_DELAY_MS;
}

function connect(): void {
  if (!running) return;
  connected = false;
  const connectionGeneration = ++generation;
  logger.info(
    `Opening IMAP IDLE connection to ${config.IMAP_HOST}:${config.IMAP_PORT}`,
  );

  let client: ImapFlow;
  try {
    // Auto-IDLE stays enabled: imapflow re-enters IDLE after commands and
    // keeps the IDLE session alive.
    client = new ImapFlow(
      BuildImapFlowOptions(config, config.IMAP_IDLE_SOCKET_TIMEOUT_MS, false),
    );
  } catch (err) {
    logger.error(`Unable to configure the IMAP IDLE connection`, err as Error);
    scheduleReconnect();
    return;
  }
  connection = client;

  client.on("error", (err) => {
    if (connectionGeneration !== generation) return;
    ImapLogConnectionError("IMAP IDLE connection error", err, config);
  });

  client.once("close", () => {
    if (connectionGeneration !== generation) return;
    logger.info(`IMAP IDLE connection closed`);
    connected = false;
    connection = undefined;
    scheduleReconnect();
  });

  void (async () => {
    try {
      await client.connect();
      if (connectionGeneration !== generation) {
        client.close();
        return;
      }
      reconnectDelay = RECONNECT_BASE_DELAY_MS;
      await client.mailboxOpen(config.IMAP_MAILBOX, { readOnly: true });
      if (connectionGeneration !== generation) {
        client.close();
        return;
      }
      connected = true;
      ImapLogConnectionEstablished(config);
      logger.info("IMAP IDLE listening for new mail");
      client.on("exists", (data) => {
        if (connectionGeneration !== generation) return;
        logger.info(
          `IMAP IDLE: ${data.count - data.prevCount} new mail(s) detected`,
        );
        scheduleFetch();
      });
    } catch (err) {
      if (connectionGeneration !== generation) return;
      ImapLogConnectionError("IMAP IDLE connection error", err, config);
      connected = false;
      // close() triggers the close handler above, which schedules the
      // reconnect with backoff.
      client.close();
    }
  })();
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

// IDLE health for /api/status: enabled stays true while the watcher is
// reconnecting (running, not connected), which is what a stall detector needs.
export function IdleWatcherGetState(): { enabled: boolean; connected: boolean } {
  return { enabled: config?.EMAIL_FETCH_IDLE === true && running, connected };
}
