import * as fs from "fs";
import * as tls from "tls";
import { ImapFlowOptions } from "imapflow";
import { Span } from "@opentelemetry/sdk-trace-base";
import { Config } from "../Config";
import { OTelLogger } from "../OTelContext";

const logger = OTelLogger().createModuleLogger("ImapConnection");

const CONNECTION_TIMEOUT_MS = 90000;
const GREETING_TIMEOUT_MS = 16000;
// Node timers (and imapflow) cap at 2^31-1 ms. imapflow treats a falsy
// socketTimeout as "use the 5 min default", so a huge value is how the
// configuration's "0 disables" is honoured.
const MAX_TIMER_DELAY_MS = 2147483647;

const TLS_ERROR_CODE_PATTERN =
  /^(CERT_|ERR_TLS_CERT_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|UNABLE_TO_)/;
const TLS_ERROR_MESSAGE_PATTERN =
  /certificate|self[- ]signed|^(?:ERR_)?TLS_|^CERT_/i;

// Certificate verification is on by default: without an explicit tls
// override imapflow/Node validate the server against the system CA store.
// IMAP_TLS_INSECURE is the only (deliberate, noisy) way to bypass it, and
// IMAP_TLS_CA_FILE adds extra trust anchors on top of the system store.
export function BuildImapFlowOptions(
  config: Config,
  socketTimeoutMs: number,
  disableAutoIdle: boolean,
): ImapFlowOptions {
  const options: ImapFlowOptions = {
    host: config.IMAP_HOST,
    port: config.IMAP_PORT,
    secure: config.IMAP_TLS,
    auth: { user: config.IMAP_USER, pass: config.IMAP_PASSWORD },
    logger: false,
    disableAutoIdle,
    connectionTimeout: CONNECTION_TIMEOUT_MS,
    greetingTimeout: GREETING_TIMEOUT_MS,
    socketTimeout:
      socketTimeoutMs > 0 ? socketTimeoutMs : MAX_TIMER_DELAY_MS,
  };

  if (config.IMAP_TLS_INSECURE) {
    options.tls = options.tls || {};
    options.tls.rejectUnauthorized = false;
    logger.warn(
      `IMAP TLS certificate verification DISABLED for ${config.IMAP_HOST}:${config.IMAP_PORT} (IMAP_TLS_INSECURE=true): the server identity is not verified`,
    );
  }

  if (config.IMAP_TLS_CA_FILE) {
    // `ca` replaces Node's default list, so include Node's bundled public
    // roots explicitly: the file adds trust anchors, it does not replace them.
    options.tls = options.tls || {};
    options.tls.ca = [
      ...tls.rootCertificates,
      fs.readFileSync(config.IMAP_TLS_CA_FILE, "utf8"),
    ];
  }

  return options;
}

export function IsImapTlsError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && TLS_ERROR_CODE_PATTERN.test(code)) {
    return true;
  }
  const message = (err as { message?: unknown }).message;
  return typeof message === "string" && TLS_ERROR_MESSAGE_PATTERN.test(message);
}

export function ImapTlsFailureMessage(config: Config): string {
  return `TLS certificate verification failed for ${config.IMAP_HOST}:${config.IMAP_PORT}: fix the server certificate or set IMAP_TLS_INSECURE=true only if you accept the risk`;
}

export function ImapLogConnectionEstablished(
  config: Config,
  span?: Span,
): void {
  if (!config.IMAP_TLS) {
    logger.info(
      `IMAP connection established without TLS (IMAP_TLS=false)`,
      span,
    );
    return;
  }
  if (config.IMAP_TLS_INSECURE) {
    logger.warn(
      `IMAP connection established WITHOUT TLS certificate verification (IMAP_TLS_INSECURE=true)`,
      span,
    );
    return;
  }
  logger.info(
    `IMAP connection established with TLS certificate verification to ${config.IMAP_HOST}:${config.IMAP_PORT}`,
    span,
  );
}

export function ImapLogConnectionError(
  prefix: string,
  err: unknown,
  config: Config,
  span?: Span,
): void {
  if (IsImapTlsError(err)) {
    logger.error(
      `${prefix}: ${ImapTlsFailureMessage(config)}`,
      err as Error,
      span,
    );
    return;
  }
  logger.error(prefix, err as Error, span);
}
