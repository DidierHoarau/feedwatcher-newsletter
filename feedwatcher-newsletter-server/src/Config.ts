import { ConfigBase } from "@devopsplaybook.io/common-utils";

export class Config extends ConfigBase {
  // IMAP settings
  public IMAP_HOST = "";
  public IMAP_PORT = 993;
  public IMAP_TLS = true;
  public IMAP_USER = "";
  public IMAP_PASSWORD = "";
  public IMAP_MAILBOX = "INBOX";

  // Schedule: hourly by default
  public EMAIL_FETCH_CRON = "0 * * * *";

  // Retention: keep emails for 3 days by default
  public EMAIL_RETENTION_DAYS = 7;

  // Batch: max emails to process per fetch (prevents unbounded run time)
  public EMAIL_FETCH_BATCH_SIZE = 200;

  // Public URL of the service
  public PUBLIC_URL = "http://localhost:8080";

  constructor() {
    super("feedwatcher-newsletter-server");
    this.addConfigField({ field: "IMAP_HOST" });
    this.addConfigField({ field: "IMAP_PORT" });
    this.addConfigField({ field: "IMAP_TLS" });
    this.addConfigField({ field: "IMAP_USER" });
    this.addConfigField({ field: "IMAP_PASSWORD", sensitive: true });
    this.addConfigField({ field: "IMAP_MAILBOX" });
    this.addConfigField({ field: "EMAIL_FETCH_CRON" });
    this.addConfigField({ field: "EMAIL_RETENTION_DAYS" });
    this.addConfigField({ field: "EMAIL_FETCH_BATCH_SIZE" });
    this.addConfigField({ field: "PUBLIC_URL" });
  }
}
