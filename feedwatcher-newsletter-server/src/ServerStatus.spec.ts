import * as fs from "fs";
import * as os from "os";
import path from "path";
import { EmailItem } from "./emails/EmailFetcher";
import {
  EmailsDataInit,
  EmailDataSetUidState,
  EmailItemsBatchSave,
} from "./emails/EmailsData";
import { IdleWatcherGetState } from "./emails/IdleWatcher";
import { SanitizedBodyCacheGet } from "./emails/SanitizedBodyCache";
import { FeedIdentityInit } from "./feeds/FeedIdentity";
import {
  ServerStatusGet,
  ServerStatusGetFetchState,
  ServerStatusRecordFetchError,
  ServerStatusRecordFetchSuccess,
} from "./ServerStatus";

jest.mock("./emails/IdleWatcher", () => ({
  IdleWatcherGetState: jest.fn(() => ({ enabled: false, connected: false })),
}));

const idleStateMock = IdleWatcherGetState as unknown as jest.Mock;

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  const now = new Date().toISOString();
  return {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
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

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "serverstatus-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
  idleStateMock.mockReturnValue({ enabled: false, connected: false });
});

describe("ServerStatusGet", () => {
  // Declared first: the module-level fetch health is fresh in this test only.
  it("reports defaults before any fetch", () => {
    expect(ServerStatusGet()).toEqual({
      started: true,
      lastSuccessfulFetchAt: null,
      lastUid: 0,
      uidvalidity: 0,
      recordCount: 0,
      idle: { enabled: false, connected: false },
      sanitizedBodyCache: { entries: 0, bytes: 0 },
      lastError: null,
    });
  });

  it("reports the UID marker and the number of indexed emails", () => {
    EmailDataSetUidState(12, 7);
    EmailItemsBatchSave([
      makeItem(),
      makeItem({
        id: "bbbbbbbb-2222-4222-8222-222222222222",
        messageId: "<msg-2@example.com>",
      }),
    ]);

    const status = ServerStatusGet();
    expect(status.lastUid).toBe(12);
    expect(status.uidvalidity).toBe(7);
    expect(status.recordCount).toBe(2);
  });

  it("reports the sanitized-body cache size", () => {
    const item = makeItem();
    EmailItemsBatchSave([item]);
    expect(ServerStatusGet().sanitizedBodyCache).toEqual({
      entries: 0,
      bytes: 0,
    });

    const sanitized = SanitizedBodyCacheGet(item);

    expect(ServerStatusGet().sanitizedBodyCache).toEqual({
      entries: 1,
      bytes: (sanitized.html.length + sanitized.summary.length) * 2,
    });
  });

  it("passes the IDLE connection state through", () => {
    idleStateMock.mockReturnValueOnce({ enabled: true, connected: false });
    expect(ServerStatusGet().idle).toEqual({
      enabled: true,
      connected: false,
    });
  });
});

describe("fetch health recording", () => {
  it("records a success timestamp and clears a previous error", () => {
    ServerStatusRecordFetchError(new Error("imap is down"));
    expect(ServerStatusGet().lastError).toBe("imap is down");

    ServerStatusRecordFetchSuccess();
    const status = ServerStatusGet();
    expect(status.lastError).toBeNull();
    expect(status.lastSuccessfulFetchAt).not.toBeNull();
    expect(new Date(status.lastSuccessfulFetchAt as string).toISOString()).toBe(
      status.lastSuccessfulFetchAt,
    );
  });

  it("collapses whitespace and truncates errors without leaking the stack", () => {
    const error = new Error(`a\nb\t c ${"x".repeat(1000)}`);
    ServerStatusRecordFetchError(error);

    const lastError = ServerStatusGet().lastError as string;
    expect(lastError.startsWith("a b c ")).toBe(true);
    expect(lastError).not.toContain("\n");
    expect(lastError.length).toBe(500);
    expect(lastError).not.toContain(error.stack as string);
  });

  it("records a single-line fallback for a non-Error value", () => {
    ServerStatusRecordFetchError("  socket\nreset  ");
    expect(ServerStatusGet().lastError).toBe("socket reset");
  });
});

describe("fetch state", () => {
  it("exposes the in-memory fetch state without reading the UID marker", () => {
    const atMs = Date.parse("2026-11-18T12:00:00.000Z");
    ServerStatusRecordFetchSuccess(atMs);
    const state = ServerStatusGetFetchState();
    expect(state.lastSuccessfulFetchAt).toBe(
      new Date(atMs).toISOString(),
    );
    expect(state.lastError).toBeNull();
    expect(state.lastChangeAtMs).toBe(atMs);

    const errorAtMs = atMs + 5000;
    ServerStatusRecordFetchError(new Error("imap down"), errorAtMs);
    const failed = ServerStatusGetFetchState();
    expect(failed.lastError).toBe("imap down");
    expect(failed.lastSuccessfulFetchAt).toBe(new Date(atMs).toISOString());
    expect(failed.lastChangeAtMs).toBe(errorAtMs);
  });

  it("clears the error and moves lastChangeAtMs on a later success", () => {
    const errorAtMs = Date.parse("2026-11-18T12:00:00.000Z");
    ServerStatusRecordFetchError("boom", errorAtMs);
    const successAtMs = errorAtMs + 60 * 1000;
    ServerStatusRecordFetchSuccess(successAtMs);
    const state = ServerStatusGetFetchState();
    expect(state.lastError).toBeNull();
    expect(state.lastChangeAtMs).toBe(successAtMs);
    expect(state.lastSuccessfulFetchAt).toBe(
      new Date(successAtMs).toISOString(),
    );
  });
});
