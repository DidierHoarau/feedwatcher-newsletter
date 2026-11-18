import * as fs from "fs";
import * as os from "os";
import path from "path";
import Fastify, { FastifyInstance } from "fastify";
import { Config } from "../Config";
import { EmailsDataInit, EmailItemsBatchSave } from "../emails/EmailsData";
import { EmailItem } from "../emails/EmailFetcher";
import { IdleWatcherGetState } from "../emails/IdleWatcher";
import { FeedIdentityInit } from "../feeds/FeedIdentity";
import {
  ServerStatusRecordFetchError,
  ServerStatusRecordFetchSuccess,
} from "../ServerStatus";
import { StatusRoutes } from "./StatusRoutes";

jest.mock("../OTelContext", () => ({
  OTelLogger: () => ({
    createModuleLogger: () => ({
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  }),
  OTelRequestSpan: () => ({}),
  OTelRunWithRequestContext: (
    _request: unknown,
    handler: () => unknown,
  ) => handler(),
}));

jest.mock("../emails/IdleWatcher", () => ({
  IdleWatcherGetState: jest.fn(() => ({ enabled: false, connected: false })),
}));

const idleMock = IdleWatcherGetState as unknown as jest.Mock;

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  const now = new Date().toISOString();
  return {
    id: "11111111-1111-4111-8111-111111111111",
    messageId: "<msg-1@example.com>",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    subject: "Issue",
    body: "<p>hi</p>",
    dateReceived: now,
    dateCreated: now,
    ...overrides,
  };
}

let dataDir: string;
let fastify: FastifyInstance;
let config: Config;

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "statusroutes-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
  EmailItemsBatchSave([makeItem()]);
  ServerStatusRecordFetchSuccess();
  idleMock.mockReturnValue({ enabled: false, connected: false });
  config = Object.assign(new Config(), {
    DATA_DIR: dataDir,
    EMAIL_FETCH_CRON: "0 * * * *",
  });
  fastify = Fastify();
  fastify.register(new StatusRoutes(config).getRoutes);
});

afterEach(async () => {
  await fastify.close();
});

describe("GET /status", () => {
  it("renders the health snapshot as HTML without a script", async () => {
    const response = await fastify.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toContain('class="badge status-ok"');
    expect(response.body).toContain("Last successful fetch");
    expect(response.body).toContain("IMAP IDLE");
    expect(response.body).toContain("disabled");
    expect(response.body).toContain("Retained records");
    expect(response.body).toContain("<dd>1</dd>");
    expect(response.body).toContain("entries, 0 bytes");
    expect(response.body).toContain("Fetch schedule");
    expect(response.body).toContain("0 * * * *");
    expect(response.body).toContain("2 hours");
    expect(response.body).toContain('<a href="/rss/">All feeds</a>');
    expect(response.body).toContain('<a href="/manage">Manage feeds</a>');
    expect(response.body).not.toContain("<script");
  });

  it("escapes the last error and shows a degraded status", async () => {
    ServerStatusRecordFetchError(
      new Error('<script>alert(1)</script> imap down'),
    );
    idleMock.mockReturnValue({ enabled: true, connected: false });

    const response = await fastify.inject({ method: "GET", url: "/status" });
    expect(response.body).toContain('class="badge status-degraded"');
    expect(response.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(response.body).not.toContain("<script>alert(1)</script>");
    expect(response.body).toContain("enabled, reconnecting");
  });

  it("shows a stale status when the last success is beyond twice the cron interval", async () => {
    ServerStatusRecordFetchSuccess(Date.now() - 3 * 60 * 60 * 1000);
    const response = await fastify.inject({ method: "GET", url: "/status" });
    expect(response.body).toContain('class="badge status-stale"');
    expect(response.body).toContain("3 hours ago");
  });

  it("warns about a fresh data directory", async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "statusroutes-empty-"));
    EmailsDataInit(7, emptyDir);
    config.DATA_DIR = emptyDir;

    const response = await fastify.inject({ method: "GET", url: "/status" });
    expect(response.body).toContain("The data directory was empty at startup");
    expect(response.body).toContain("/data</code>");
    expect(response.body).toContain('role="alert"');
  });

  it("does not warn when persisted state existed at startup", async () => {
    const persistedDir = fs.mkdtempSync(path.join(os.tmpdir(), "statusroutes-"));
    fs.writeFileSync(path.join(persistedDir, "emails.jsonl"), "");
    EmailsDataInit(7, persistedDir);

    const persisted = await fastify.inject({ method: "GET", url: "/status" });
    expect(persisted.statusCode).toBe(200);
    expect(persisted.body).not.toContain("data directory was empty");
  });
});
