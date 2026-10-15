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
    return;
  }
  running = true;
  connect();
}

function connect(): void {
  if (!running) return;
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
  });

  imap.once("ready", () => {
    reconnectDelay = RECONNECT_BASE_DELAY_MS;
    imap.openBox(config.IMAP_MAILBOX, true, (err) => {
      if (err) {
        logger.error(`Error opening mailbox for IDLE`, err);
        imap.end();
        return;
      }
      logger.info("IMAP IDLE listening for new mail");
      imap.on("mail", (numNewMail: number) => {
        logger.info(`IMAP IDLE: ${numNewMail} new mail(s) detected`);
        scheduleFetch();
      });
    });
  });

  imap.once("error", (err) => {
    logger.error(`IMAP IDLE connection error`, err);
  });

  imap.once("close", (hadError: boolean) => {
    logger.info(`IMAP IDLE connection closed (error: ${hadError})`);
    scheduleReconnect();
  });

  imap.connect();
}

function scheduleReconnect(): void {
  if (!running) return;
  logger.info(
    `Reconnecting IMAP IDLE in ${Math.round(reconnectDelay / 1000)}s`,
  );
  setTimeout(() => connect(), reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
}

function scheduleFetch(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => triggerFetch(), FETCH_DEBOUNCE_MS);
}
