import * as fs from "fs";
import * as os from "os";
import path from "path";
import { EventEmitter } from "events";
import { Span } from "@opentelemetry/sdk-trace-base";
import { Config } from "../Config";
import { EmailFetcherFetchEmails } from "./EmailFetcher";
import {
  EmailsDataInit,
  EmailDataGetUidState,
  EmailDataSetUidState,
  EmailItemsBatchSave,
} from "./EmailsData";

// A fake IMAP client defined inside the factory (jest.mock is hoisted above
// the imports, so a top-level class reference is not available here). Tests
// configure its behaviour through the static `script` and inspect every
// instance thanks to `instances`.
jest.mock("imap", () => {
  const { EventEmitter: Emitter } = jest.requireActual("events");
  class FakeImap extends Emitter {
    static instances: any[] = [];
    static script: any = {};
    config: any;
    searches: any[] = [];
    fetches: number[][] = [];
    connectCalls = 0;
    endCalls = 0;
    destroyCalls = 0;
    constructor(config: any) {
      super();
      this.config = config;
      FakeImap.instances.push(this);
    }
    connect() {
      this.connectCalls++;
      const script = FakeImap.script;
      setImmediate(() => {
        if (script.onConnect) {
          script.onConnect(this);
          return;
        }
        this.emit("ready");
      });
    }
    openBox(_name: string, _readOnly: boolean, cb: any) {
      const script = FakeImap.script;
      setImmediate(() => cb(null, script.box || { uidvalidity: 1 }));
    }
    search(criteria: any[], cb: any) {
      this.searches.push(criteria);
      const script = FakeImap.script;
      const error = script.searchErrors?.shift();
      setImmediate(() => {
        if (error) {
          cb(error, []);
          return;
        }
        cb(null, script.searchResults || []);
      });
    }
    fetch(uids: number[], _options: any) {
      const script = FakeImap.script;
      const fetch = new Emitter();
      this.fetches.push([...uids]);
      setImmediate(() => {
        if (script.onFetch) {
          script.onFetch({ imap: this, fetch, uids });
          return;
        }
        for (const raw of script.messages || []) {
          const msg = new Emitter();
          fetch.emit("message", msg, 1);
          const stream = new Emitter();
          msg.emit("body", stream);
          stream.emit("data", Buffer.from(raw));
          stream.emit("end");
        }
        fetch.emit("end");
      });
      return fetch;
    }
    end() {
      this.endCalls++;
      setImmediate(() => this.emit("end"));
    }
    destroy() {
      this.destroyCalls++;
      setImmediate(() => this.emit("close"));
    }
  }
  return { __esModule: true, default: FakeImap };
});

jest.mock("../OTelContext", () => {
  const mockSpan = { end: jest.fn() };
  return {
    OTelLogger: () => ({
      createModuleLogger: () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
      }),
    }),
    OTelTracer: () => ({ startSpan: jest.fn(() => mockSpan) }),
    __mockSpan: mockSpan,
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

const FakeImap = jest.requireMock("imap").default;
const mockSpan = jest.requireMock("../OTelContext").__mockSpan;
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
  return FakeImap.instances[FakeImap.instances.length - 1];
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
  FakeImap.instances.length = 0;
  FakeImap.script = { box: { uidvalidity: 1 }, searchResults: [], messages: [] };
});

afterEach(async () => {
  // Let pending setImmediate callbacks of the fake settle before the next test.
  await new Promise((resolve) => setImmediate(resolve));
  jest.useRealTimers();
});

describe("EmailFetcherFetchEmails", () => {
  it("fetches, saves and advances the marker after a durable append", async () => {
    FakeImap.script = {
      box: { uidvalidity: 9 },
      searchResults: [1, 2],
      messages: [rawEmail(1, "<m1@example.com>"), rawEmail(2, "<m2@example.com>")],
    };
    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.config.socketTimeout).toBe(120000);
    expect(imap.fetches).toEqual([[1, 2]]);
    expect(batchSaveMock).toHaveBeenCalledTimes(1);
    const saved = batchSaveMock.mock.calls[0][0];
    expect(saved.map((item: any) => item.messageId)).toEqual([
      "<m1@example.com>",
      "<m2@example.com>",
    ]);
    expect(setUidStateMock).toHaveBeenCalledWith(2, 9);
    expect(EmailDataGetUidState()).toEqual({ uid: 2, uidvalidity: 9 });
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("fails the run and keeps the marker when the journal append fails", async () => {
    seedUidState(4, 9);
    FakeImap.script = {
      box: { uidvalidity: 9 },
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
  });

  it("resets the marker when UIDVALIDITY changes and re-ingests lower UIDs", async () => {
    seedUidState(10, 111);
    FakeImap.script = {
      box: { uidvalidity: 222 },
      searchResults: [3, 11],
      messages: [rawEmail(3, "<m3@example.com>"), rawEmail(11, "<m11@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([["ALL"]]);
    expect(imap.fetches).toEqual([[3, 11]]);
    expect(setUidStateMock).toHaveBeenCalledWith(0, 222);
    expect(setUidStateMock).toHaveBeenCalledWith(11, 222);
    expect(EmailDataGetUidState()).toEqual({ uid: 11, uidvalidity: 222 });
  });

  it("adopts the mailbox UIDVALIDITY for a legacy marker without resetting the UID", async () => {
    fs.writeFileSync(path.join(dataDir, "last-uid.txt"), "10");
    FakeImap.script = {
      box: { uidvalidity: 7 },
      searchResults: [11],
      messages: [rawEmail(11, "<m11@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([[["UID", "11:*"]]]);
    expect(imap.fetches).toEqual([[11]]);
    expect(setUidStateMock).toHaveBeenCalledWith(10, 7);
    expect(EmailDataGetUidState()).toEqual({ uid: 11, uidvalidity: 7 });
  });

  it("uses a UID range search and filters results to UIDs above the marker", async () => {
    seedUidState(10, 1);
    FakeImap.script = {
      box: { uidvalidity: 1 },
      // `n:*` may also return the highest UID below n.
      searchResults: [10, 11, 12],
      messages: [rawEmail(11, "<m11@example.com>"), rawEmail(12, "<m12@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([[["UID", "11:*"]]]);
    expect(imap.fetches).toEqual([[11, 12]]);
    expect(EmailDataGetUidState()).toEqual({ uid: 12, uidvalidity: 1 });
  });

  it("falls back to a full mailbox search when the UID range search fails", async () => {
    seedUidState(10, 1);
    FakeImap.script = {
      box: { uidvalidity: 1 },
      searchErrors: [new Error("UID search not supported")],
      searchResults: [10, 11],
      messages: [rawEmail(11, "<m11@example.com>")],
    };

    await EmailFetcherFetchEmails(contextSpan, makeConfig());

    const imap = lastImap();
    expect(imap.searches).toEqual([[["UID", "11:*"]], ["ALL"]]);
    expect(imap.fetches).toEqual([[11]]);
  });

  it("settles the run when the connection ends mid-fetch", async () => {
    FakeImap.script = {
      box: { uidvalidity: 1 },
      searchResults: [1],
      onFetch: ({ imap, fetch }: { imap: any; fetch: EventEmitter }) => {
        const msg = new EventEmitter();
        fetch.emit("message", msg, 1);
        const stream = new EventEmitter();
        msg.emit("body", stream);
        stream.emit("data", Buffer.from(rawEmail(1, "<m1@example.com>")));
        // The stream never ends; the connection drops instead.
        setImmediate(() => imap.emit("end"));
      },
    };

    await expect(
      EmailFetcherFetchEmails(contextSpan, makeConfig()),
    ).rejects.toThrow(/ended before the fetch/);
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
    expect(batchSaveMock).not.toHaveBeenCalled();
  });

  it("aborts a stalled connection at the fetch deadline", async () => {
    FakeImap.script = {
      box: { uidvalidity: 1 },
      searchResults: [1],
      // The fetch never emits anything: the run would hang without a deadline.
      onFetch: () => {},
    };

    await expect(
      EmailFetcherFetchEmails(
        contextSpan,
        makeConfig({ EMAIL_FETCH_DEADLINE_MS: 50 }),
      ),
    ).rejects.toThrow(/deadline exceeded/);

    const imap = lastImap();
    expect(imap.destroyCalls).toBeGreaterThan(0);
    expect(mockSpan.end).toHaveBeenCalledTimes(1);
  });

  it("splits a batch into slices and advances the marker after each slice", async () => {
    const uids = Array.from({ length: 51 }, (_, i) => i + 1);
    FakeImap.script = {
      box: { uidvalidity: 1 },
      searchResults: uids,
      onFetch: ({ fetch, uids: fetchUids }: { fetch: EventEmitter; uids: number[] }) => {
        for (const uid of fetchUids) {
          const msg = new EventEmitter();
          fetch.emit("message", msg, 1);
          const stream = new EventEmitter();
          msg.emit("body", stream);
          stream.emit("data", Buffer.from(rawEmail(uid, `<m${uid}@example.com>`)));
          stream.emit("end");
        }
        fetch.emit("end");
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
    FakeImap.script = {
      box: { uidvalidity: 1 },
      searchResults: [1, 2, 3, 4, 5],
      onFetch: ({ fetch, uids: fetchUids }: { fetch: EventEmitter; uids: number[] }) => {
        for (const uid of fetchUids) {
          const msg = new EventEmitter();
          fetch.emit("message", msg, 1);
          const stream = new EventEmitter();
          msg.emit("body", stream);
          stream.emit("data", Buffer.from(rawEmail(uid, `<m${uid}@example.com>`)));
          stream.emit("end");
        }
        fetch.emit("end");
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
    FakeImap.script = {
      box: { uidvalidity: 1 },
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
});
