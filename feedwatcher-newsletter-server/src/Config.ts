import { ConfigBase } from "@devopsplaybook.io/common-utils";
import * as fs from "fs";
import path from "path";
import { FeedOverride } from "./feeds/FeedIdentity";

// ConfigBase reports the shared library's own version; telemetry must identify
// this service. Resolves from src (Jest) and from dist (node dist/App.js).
function detectServerVersion(): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../package.json"), "utf8"),
    );
    if (
      pkg?.name === "feedwatcher-newsletter-server" &&
      typeof pkg.version === "string"
    ) {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0";
}

export class Config extends ConfigBase {
  // IMAP settings
  public IMAP_HOST = "";
  public IMAP_PORT = 993;
  public IMAP_TLS = true;
  public IMAP_USER = "";
  public IMAP_PASSWORD = "";
  public IMAP_MAILBOX = "INBOX";

  // TLS: the server certificate is verified against the system CA store by
  // default. IMAP_TLS_INSECURE disables verification (unsafe, opt-in only);
  // IMAP_TLS_CA_FILE adds extra trust anchors (e.g. a self-hosted CA).
  public IMAP_TLS_INSECURE = false;
  public IMAP_TLS_CA_FILE = "";

  // Schedule: hourly by default
  public EMAIL_FETCH_CRON = "0 * * * *";

  // Retention: keep emails for 3 days by default
  public EMAIL_RETENTION_DAYS = 3;

  // Batch: max emails to process per fetch (prevents unbounded run time)
  public EMAIL_FETCH_BATCH_SIZE = 200;

  // Catch-up: max emails to process within a single run, across successive
  // batches, so a backlog larger than the batch size drains instead of
  // progressing one batch per run
  public EMAIL_FETCH_RUN_BUDGET = 2000;

  // Retry: attempts for transient IMAP failures within one cycle
  public EMAIL_FETCH_RETRIES = 2;
  public EMAIL_FETCH_RETRY_DELAY_MS = 10000;

  // Timeouts: the IMAP client's socketTimeout protects a stalled fetch
  // connection; the fetch deadline bounds a whole run regardless of socket
  // activity. 0 disables the corresponding timeout.
  public IMAP_SOCKET_TIMEOUT_MS = 120000;
  public IMAP_IDLE_SOCKET_TIMEOUT_MS = 600000;
  public EMAIL_FETCH_DEADLINE_MS = 300000;

  // IDLE: keep a long-lived IMAP connection for near-real-time ingestion,
  // with the cron schedule kept as fallback
  public EMAIL_FETCH_IDLE = true;

  // Content hygiene: strip tracking-pixel images (1x1, or a single known
  // dimension <= 1) from email bodies
  public EMAIL_STRIP_TRACKING_PIXELS = true;

  // Privacy: replace remote (http/https) image sources with an inert
  // placeholder so newsletters cannot track the reader's IP/timing. Off by
  // default because images no longer render.
  public EMAIL_BLOCK_REMOTE_IMAGES = false;

  // Privacy: advertise and emit unguessable feed URLs (<feedId>.<token>);
  // bare feed ids keep working unless strict mode is enabled
  public FEED_PRIVATE_URLS = true;

  // Privacy: reject bare feed ids when FEED_PRIVATE_URLS is enabled. Opt-in
  // because bare-id subscriptions stop working.
  public FEED_PRIVATE_URLS_STRICT = false;

  // Access control: optional HTTP Basic auth protecting /, /rss/* and /view/*.
  // Enabled when AUTH_PASSWORD is non-empty; disabled by default.
  public AUTH_USERNAME = "feedwatcher";
  public AUTH_PASSWORD = "";

  // Proxy: trust X-Forwarded-Proto/Host from a reverse proxy when deriving
  // request-based feed URLs. Restart-only. Default false (headers ignored).
  public TRUST_PROXY = false;

  // Feed control: comma-separated sender name/email fragments whose emails
  // are never ingested or listed as feeds
  public SENDER_IGNORE_LIST = "";

  // Feed control: map a sender email or name to a stable feed id and/or
  // title, e.g. { "news@example.com": { "feedId": "daily", "title": "The Daily" } }
  public FEED_OVERRIDES: Record<string, FeedOverride> = {};

  // Public URL of the service; when empty, feed URLs are derived from the
  // incoming request
  public PUBLIC_URL = "";

  constructor() {
    super("feedwatcher-newsletter-server");
    // An explicit VERSION env/config value still wins: reload() only
    // overwrites VERSION when one is supplied.
    this.VERSION = detectServerVersion();
    this.addConfigField({ field: "IMAP_HOST" });
    this.addConfigField({ field: "IMAP_PORT" });
    this.addConfigField({ field: "IMAP_TLS" });
    this.addConfigField({ field: "IMAP_USER" });
    this.addConfigField({ field: "IMAP_PASSWORD", sensitive: true });
    this.addConfigField({ field: "IMAP_MAILBOX" });
    this.addConfigField({ field: "IMAP_TLS_INSECURE" });
    this.addConfigField({ field: "IMAP_TLS_CA_FILE" });
    this.addConfigField({ field: "EMAIL_FETCH_CRON" });
    this.addConfigField({ field: "EMAIL_RETENTION_DAYS" });
    this.addConfigField({ field: "EMAIL_FETCH_BATCH_SIZE" });
    this.addConfigField({ field: "EMAIL_FETCH_RUN_BUDGET" });
    this.addConfigField({ field: "EMAIL_FETCH_RETRIES" });
    this.addConfigField({ field: "EMAIL_FETCH_RETRY_DELAY_MS" });
    this.addConfigField({ field: "IMAP_SOCKET_TIMEOUT_MS" });
    this.addConfigField({ field: "IMAP_IDLE_SOCKET_TIMEOUT_MS" });
    this.addConfigField({ field: "EMAIL_FETCH_DEADLINE_MS" });
    this.addConfigField({ field: "EMAIL_FETCH_IDLE" });
    this.addConfigField({ field: "EMAIL_STRIP_TRACKING_PIXELS" });
    this.addConfigField({ field: "EMAIL_BLOCK_REMOTE_IMAGES" });
    this.addConfigField({ field: "FEED_PRIVATE_URLS" });
    this.addConfigField({ field: "FEED_PRIVATE_URLS_STRICT" });
    this.addConfigField({ field: "AUTH_USERNAME" });
    this.addConfigField({ field: "AUTH_PASSWORD", sensitive: true });
    this.addConfigField({ field: "TRUST_PROXY" });
    this.addConfigField({ field: "SENDER_IGNORE_LIST" });
    this.addConfigField({ field: "FEED_OVERRIDES" });
    this.addConfigField({ field: "PUBLIC_URL" });
  }

  // Hot reload: validate the whole configuration into a fresh instance and
  // copy the declared fields onto this shared instance only when reload()
  // succeeds, so a rejected value never leaves a partially applied config.
  public async reloadAtomic(
    logger?: (message: string) => void,
  ): Promise<void> {
    const staging = new Config();
    await staging.reload(logger);
    const stagingValues = staging as unknown as Record<string, unknown>;
    const fields = (
      staging as unknown as { _fields: Array<{ field: string }> }
    )._fields;
    for (const { field } of fields) {
      (this as unknown as Record<string, unknown>)[field] =
        stagingValues[field];
    }
  }
}
