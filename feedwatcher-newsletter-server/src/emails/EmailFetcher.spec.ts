import * as fs from "fs";
import * as os from "os";
import path from "path";
import { Span } from "@opentelemetry/api";
import { Config } from "../Config";
import { EmailFetcherFetchEmails } from "./EmailFetcher";
import {
  EmailsDataInit,
  EmailDataGetUidState,
  EmailDataSetUidState,
  EmailItemsBatchSave,
} from "./EmailsData";

// A fake ImapFlow client defined inside the factory (jest.mock is hoisted
// above the imports, so a top-level class reference is not available here).
// Tests configure its behaviour through the static `script` and inspect every
// instance thanks to `instances`.
jest.mock("imapflow", () => {
  const { EventEmitter: Emitter } = jest.requireActual("events");
  class FakeImapFlow extends Emitter {
    static instances: any[] = [];
    static script: any = {};
    options: any;
    searches: any[] = [];
    searchOptions: any;
    fetches: number[][] = [];
    fetchQuery: any;
    fetchOptions: any;
    lockArgs: any;
    lockReleased = false;
    connectCalls = 0;
    closeCalls = 0;
    logoutCalls = 0;
    mailbox: any;
    lost: Promise<never>;
    lostReject!: (err: Error) => void;
    constructor(options: any) {
      super();
      this.options = options;
      this.mailbox = FakeImapFlow.script.box;
      FakeImapFlow.instances.push(this);
      this.lost = new Promise((_resolve, reject) => {
        this.lostReject = reject;
      });
      // The rejection is consumed by whichever operation waits for it; the
      // extra catch only prevents an unhandled rejection when nothing does.
      this.lost.catch(() => {});
      this.on("close", () =>
        this.lostReject(new Error("IMAP connection closed")),
      );
      this.on("error", (err: Error) => this.lostReject(err));
    }
    async connect() {
      this.connectCalls++;
      const script = FakeImapFlow.script;
      if (script.connectError) {
        // imapflow rejects connect() and closes the connection right after.
        setImmediate(() => this.emit("close"));
        throw script.connectError;
      }
      if (script.onConnect) {
        await script.onConnect(this);
      }
    }
    async getMailboxLock(name: string, options: any) {
      this.lockArgs = { name, options };
      this.mailbox = FakeImapFlow.script.box;
      return {
        path: name,
        release: () => {
          this.lockReleased = true;
        },
      };
    }
    async search(query: any, options: any) {
      this.searches.push(query);
      this.searchOptions = options;
      const script = FakeImapFlow.script;
      const error = script.searchErrors?.shift();
      if (error) throw error;
      return script.searchResults || [];
    }
    fetch(range: string, query: any, options: any) {
      const uids = String(range).split(",").map(Number);
      this.fetches.push(uids);
      this.fetchQuery = query;
      this.fetchOptions = options;
      return this.generateMessages(FakeImapFlow.script, uids);
    }
    private async *generateMessages(script: any, uids: number[]) {
      if (script.onFetch) {
        yield* script.onFetch(this, uids);
        return;
      }
      for (const raw of script.messages || []) {
        yield { source: Buffer.from(raw) };
      }
    }
    async logout() {
      this.logoutCalls++;
      this.emit("close");
    }
    close() {
      this.closeCalls++;
      this.emit("close");
    }
  }
  return { __esModule: true, ImapFlow: FakeImapFlow };
});

jest.mock("../OTelContext", () => {
  const mockSpan = { end: jest.fn() };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    OTelTracer: () => ({ startSpan: jest.fn(() => mockSpan) }),
    __mockSpan: mockSpan,
    __mockLogger: logger,
  };
});

jest.mock("../utils-std-ts/Timeout", () => ({
  TimeoutWait: jest.fn(() => Promise.resolve()),
}));

jest.mock("./EmailsData", () => {
  const actual = jest.requireActual("./EmailsData");
  return {
    ...actual,
    EmailItemsBatchSave: jest.fn(actual.EmailItemsBatchSave),
    EmailDataSetUidState: jest.fn(actual.EmailDataSetUidState),
  };
});

const FakeImapFlow = jest.requireMock("imapflow").ImapFlow;
const mockSpan = jest.requireMock("../OTelContext").__mockSpan;
const mockLogger = jest.requireMock("../OTelContext").__mockLogger;
const batchSaveMock = EmailItemsBatchSave as unknown as jest.Mock;
const setUidStateMock = EmailDataSetUidState as unknown as jest.Mock;

let dataDir: string;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return Object.assign(new Config(), {
    IMAP_HOST: "imap.example.com",
    IMAP_USER: "newsletter@example.com",
    IMAP_PASSWORD: "secret",
    IMAP_MAILBOX: "INBOX",
    IMAP_SOCKET_TIMEOUT_MS: 120000,
    EMAIL_FETCH_BATCH_SIZE: 200,
    EMAIL_FETCH_RUN_BUDGET: 2000,
    EMAIL_FETCH_DEADLINE_MS: 300000,
    ...overrides,
  });
}

function lastImap(): any {
  return FakeImapFlow.instances[FakeImapFlow.instances.length - 1];
}

function seedUidState(uid: number, uidvalidity: number): void {
  fs.writeFileSync(
    path.join(dataDir, "last-uid.json"),
    JSON.stringify({ uid, uidvalidity }),
  );
}

function rawEmail(uid: number, messageId?: string): string {
  const headers = [
    "From: The Daily <news@example.com>",
    `Subject: Issue ${uid}`,
    "Date: Wed, 22 Oct 2025 10:00:00 +0000",
    "Content-Type: text/plain; charset=utf-8",
  ];
  if (messageId !== undefined) {
    headers.push(`Message-ID: ${messageId}`);
  }
  return `${headers.join("\r\n")}\r\n\r\nBody ${uid}\r\n`;
}

const contextSpan = {} as Span;

beforeEach(() => {
  jest.clearAllMocks();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "emailfetcher-"));
  EmailsDataInit(7, dataDir);
  FakeImapFlow.instances.length = 0;
  FakeImapFlow.script = { box: { uidValidity: 1 }, searchResults: [], messages: [] };
});

afterEach(async () => {
  // Let pending setImmediate callbacks of the fake settle before the next test.
  await new Promise((resolve) => setImmediate(resolve));
  jest.useRealTimers();
});

describe("EmailFetcherFetchEmails", () => {
  it("fetches, saves and advances the marker after a durable append", async () => {
    FakeImapFlow.script = {
      box: { uidValidity: 9 },
      searchResults: [1, 2],
      messages: [rawEmail(1, "<m1@example.com>"), rawEmail(2, "<m2@example.com>")],
    };
    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.options.socketTimeout).toBe(120000);
    expect(imap.options.disableAutoIdle).toBe(true);
    // No tls override: Node's default certificate verification applies.
    expect(imap.options.tls).toBeUndefined();
    expect(imap.searches).toEqual([{ all: true }]);
    expect(imap.searchOptions).toEqual({ uid: true });
    expect(imap.fetches).toEqual([[1, 2]]);
    expect(imap.fetchQuery).toEqual({ uid: true, source: true });
    expect(imap.fetchOptions).toEqual({ uid: true });
    expect(imap.lockArgs).toEqual({ name: "INBOX", options: { readOnly: false } });
    expect(imap.lockReleased).toBe(true);
    expect(imap.logoutCalls).toBe(1);
    expect(batchSaveMock).toHaveBeenCalledTimes(1);
    const saved = batchSaveMock.mock.calls[0][0];
    expect(saved.map((item: any) => item.messageId)).toEqual([
      "<m1@example.com>",
      "<m2@example.com>",
    ]);
    expect(setUidStateMock).toHaveBeenCalledWith(2, 9);
    expect(EmailDataGetUidState()).toEqual({ uid: 2, uidvalidity: 9 });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        "IMAP connection established with TLS certificate verification",
      ),
      expect.anything(),
    );
  });

  it("fails the run and keeps the marker when the journal append fails", async () => {
    seedUidState(4, 9);
    FakeImapFlow.script = {
      box: { uidValidity: 9 },
      searchResults: [5],
      messages: [rawEmail(5, "<m5@example.com>")],
    };
    batchSaveMock.mockImplementationOnce(() => {
      throw new Error("disk full");
    });

    await expect(
      EmailFetcherFetchEmails(contextSpan, makeConfig()),
    ).rejects.toThrow("disk full");

    expect(setUidStateMock).not.toHaveBeenCalledWith(5, 9);
    expect(EmailDataGetUidState()).toEqual({ uid: 4, uidvalidity: 9 });
    expect(EmailItemsBatchSave).toHaveBeenCalledTimes(1);
    expect(lastImap().closeCalls).toBeGreaterThan(0);
  });

  it("resets the marker when UIDVALIDITY changes and re-ingests lower UIDs", async () => {
    seedUidState(10, 111);
    FakeImapFlow.script = {
      box: { uidValidity: 222 },
      searchResults: [3, 11],
      messages: [rawEmail(3, "<m3@example.com>"), rawEmail(11, "<m11@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([{ all: true }]);
    expect(imap.fetches).toEqual([[3, 11]]);
    expect(setUidStateMock).toHaveBeenCalledWith(0, 222);
    expect(setUidStateMock).toHaveBeenCalledWith(11, 222);
    expect(EmailDataGetUidState()).toEqual({ uid: 11, uidvalidity: 222 });
  });

  it("adopts the mailbox UIDVALIDITY for a legacy marker without resetting the UID", async () => {
    fs.writeFileSync(path.join(dataDir, "last-uid.txt"), "10");
    FakeImapFlow.script = {
      box: { uidValidity: 7 },
      searchResults: [11],
      messages: [rawEmail(11, "<m11@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([{ uid: "11:*" }]);
    expect(imap.fetches).toEqual([[11]]);
    expect(setUidStateMock).toHaveBeenCalledWith(10, 7);
    expect(EmailDataGetUidState()).toEqual({ uid: 11, uidvalidity: 7 });
  });

  it("uses a UID range search and filters results to UIDs above the marker", async () => {
    seedUidState(10, 1);
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      // `n:*` may also return the highest UID below n.
      searchResults: [10, 11, 12],
      messages: [rawEmail(11, "<m11@example.com>"), rawEmail(12, "<m12@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([{ uid: "11:*" }]);
    expect(imap.fetches).toEqual([[11, 12]]);
    expect(EmailDataGetUidState()).toEqual({ uid: 12, uidvalidity: 1 });
  });

  it("falls back to a full mailbox search when the UID range search fails", async () => {
    seedUidState(10, 1);
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      searchErrors: [new Error("UID search not supported")],
      searchResults: [10, 11],
      messages: [rawEmail(11, "<m11@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([{ uid: "11:*" }, { all: true }]);
    expect(imap.fetches).toEqual([[11]]);
  });

  it("settles the run when the connection closes mid-fetch", async () => {
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      searchResults: [1],
      onFetch: async function* (imap: any) {
        yield { source: Buffer.from(rawEmail(1, "<m1@example.com>")) };
        // The message stream never completes; the connection drops instead.
        setImmediate(() => imap.emit("close"));
        await imap.lost;
      },
    };

    await expect(
      EmailFetcherFetchEmails(contextSpan, makeConfig()),
    ).rejects.toThrow(/closed before the fetch completed/);
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
    expect(batchSaveMock).not.toHaveBeenCalled();
  });

  it("aborts a stalled connection at the fetch deadline", async () => {
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      searchResults: [1],
      // The fetch never emits anything: the run would hang without a deadline.
      onFetch: async function* () {
        await new Promise(() => {});
        yield { source: Buffer.alloc(0) };
      },
    };

    await expect(
      EmailFetcherFetchEmails(
        contextSpan,
        makeConfig({ EMAIL_FETCH_DEADLINE_MS: 50 }),
      ),
    ).rejects.toThrow(/deadline exceeded/);

    const imap = lastImap();
    expect(imap.closeCalls).toBeGreaterThan(0);
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("splits a batch into slices and advances the marker after each slice", async () => {
    const uids = Array.from({ length: 51 }, (_, i) => i + 1);
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      searchResults: uids,
      onFetch: async function* (_imap: any, fetchUids: number[]) {
        for (const uid of fetchUids) {
          yield { source: Buffer.from(rawEmail(uid, `<m${uid}@example.com>`)) };
        }
      },
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.fetches).toEqual([
      uids.slice(0, 50),
      uids.slice(50),
    ]);
    expect(setUidStateMock).toHaveBeenCalledWith(50, 1);
    expect(setUidStateMock).toHaveBeenCalledWith(51, 1);
    expect(batchSaveMock).toHaveBeenCalledTimes(2);
  });

  it("stops at the run budget", async () => {
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      searchResults: [1, 2, 3, 4, 5],
      onFetch: async function* (_imap: any, fetchUids: number[]) {
        for (const uid of fetchUids) {
          yield { source: Buffer.from(rawEmail(uid, `<m${uid}@example.com>`)) };
        }
      },
    };

    await EmailFetcherFetchEmails(
      contextSpan,
      makeConfig({ EMAIL_FETCH_BATCH_SIZE: 2, EMAIL_FETCH_RUN_BUDGET: 3 }),
    );

    const imap = lastImap();
    expect(imap.fetches).toEqual([[1, 2], [3]]);
    expect(EmailDataGetUidState()).toEqual({ uid: 3, uidvalidity: 1 });
  });

  it("uses distinct UUIDs as fallback ids for emails without a Message-ID", async () => {
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      searchResults: [1, 2],
      messages: [rawEmail(1), rawEmail(2)],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const saved = batchSaveMock.mock.calls[0][0];
    expect(saved).toHaveLength(2);
    const [first, second] = saved.map((item: any) => item.messageId);
    expect(first).not.toBe(second);
    const uuidV4 = /^no-id-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    expect(first).toMatch(uuidV4);
    expect(second).toMatch(uuidV4);
  });

  it("logs an actionable TLS error and fails without disabling verification", async () => {
    const certError = Object.assign(
      new Error("self-signed certificate in certificate chain"),
      { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    );
    FakeImapFlow.script = {
      box: { uidValidity: 1 },
      connectError: certError,
    };

    await expect(
      EmailFetcherFetchEmails(contextSpan, makeConfig()),
    ).rejects.toThrow(/self-signed/);

    const imap = lastImap();
    // No silent fallback: the TLS options still verify the server.
    expect(imap.options.tls).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("TLS certificate verification failed"),
      expect.any(Error),
      expect.anything(),
    );
    expect(batchSaveMock).not.toHaveBeenCalled();
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });
});
