import { Config } from "../Config";
import { IdleWatcherStart, IdleWatcherStop } from "./IdleWatcher";

jest.mock("imapflow", () => {
  const { EventEmitter: Emitter } = jest.requireActual("events");
  class FakeImapFlow extends Emitter {
    static instances: any[] = [];
    static script: any = {};
    options: any;
    openBoxArgs: any;
    connectCalls = 0;
    closeCalls = 0;
    constructor(options: any) {
      super();
      this.options = options;
      FakeImapFlow.instances.push(this);
    }
    async connect() {
      this.connectCalls++;
      if (FakeImapFlow.script.connectError) {
        throw FakeImapFlow.script.connectError;
      }
    }
    async mailboxOpen(name: string, options: any) {
      this.openBoxArgs = { name, options };
      return { uidValidity: 1n };
    }
    close() {
      this.closeCalls++;
      this.emit("close");
    }
  }
  return { __esModule: true, ImapFlow: FakeImapFlow };
});

jest.mock("../OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    __mockLogger: logger,
  };
});

const FakeImapFlow = jest.requireMock("imapflow").ImapFlow;
const mockLogger = jest.requireMock("../OTelContext").__mockLogger;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return Object.assign(new Config(), {
    IMAP_HOST: "imap.example.com",
    IMAP_USER: "newsletter@example.com",
    IMAP_PASSWORD: "secret",
    IMAP_MAILBOX: "INBOX",
    EMAIL_FETCH_IDLE: true,
    IMAP_IDLE_SOCKET_TIMEOUT_MS: 600000,
    ...overrides,
  });
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  jest.useFakeTimers();
  IdleWatcherStop();
  FakeImapFlow.instances.length = 0;
  FakeImapFlow.script = {};
  jest.clearAllMocks();
});

afterEach(() => {
  IdleWatcherStop();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("IdleWatcher", () => {
  it("opens one IDLE connection with auto-IDLE and TLS verification", async () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    await flushMicrotasks();

    expect(FakeImapFlow.instances).toHaveLength(1);
    const imap = FakeImapFlow.instances[0];
    expect(imap.options.socketTimeout).toBe(600000);
    expect(imap.options.disableAutoIdle).toBe(false);
    expect(imap.options.tls).toBeUndefined();
    expect(imap.openBoxArgs).toEqual({ name: "INBOX", options: { readOnly: true } });
  });

  it("is idempotent: a second start does not open a second connection", async () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    IdleWatcherStart(makeConfig(), jest.fn());
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(1);
  });

  it("does not connect when EMAIL_FETCH_IDLE is disabled", () => {
    IdleWatcherStart(makeConfig({ EMAIL_FETCH_IDLE: false }), jest.fn());
    expect(FakeImapFlow.instances).toHaveLength(0);
  });

  it("reconnects after an IMAP error and close with the 30s base delay", async () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    await flushMicrotasks();
    const imap = FakeImapFlow.instances[0];

    // imapflow closes the connection right after an error.
    imap.emit("error", new Error("socket reset"));
    imap.emit("close");
    expect(FakeImapFlow.instances).toHaveLength(1);

    jest.advanceTimersByTime(29999);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(2);
  });

  it("doubles the reconnect delay when reconnections keep failing", async () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    await flushMicrotasks();

    // Every following connection attempt fails immediately.
    FakeImapFlow.script = { connectError: new Error("server down") };

    // First failure: 30s.
    FakeImapFlow.instances[0].emit("close");
    jest.advanceTimersByTime(30000);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(2);

    // The reconnection failed too: next attempt waits 60s.
    jest.advanceTimersByTime(59999);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(2);
    jest.advanceTimersByTime(1);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(3);
  });

  it("resets the backoff after a successful reconnection", async () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    await flushMicrotasks();

    FakeImapFlow.instances[0].emit("close");
    jest.advanceTimersByTime(30000);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(2);

    // The second connection succeeded, so the next failure waits 30s again.
    FakeImapFlow.instances[1].emit("close");
    jest.advanceTimersByTime(30000);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(3);
  });

  it("does not reconnect after a stop", async () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    await flushMicrotasks();
    FakeImapFlow.instances[0].emit("close");

    IdleWatcherStop();
    jest.advanceTimersByTime(3600000);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(1);
  });

  it("debounces a burst of new-mail notifications into one fetch", async () => {
    const triggerFetch = jest.fn();
    IdleWatcherStart(makeConfig(), triggerFetch);
    await flushMicrotasks();
    const imap = FakeImapFlow.instances[0];

    imap.emit("exists", { count: 1, prevCount: 0 });
    jest.advanceTimersByTime(5000);
    imap.emit("exists", { count: 2, prevCount: 1 });
    jest.advanceTimersByTime(9999);
    expect(triggerFetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(triggerFetch).toHaveBeenCalledTimes(1);
  });

  it("logs an actionable TLS error and keeps reconnecting without disabling verification", async () => {
    FakeImapFlow.script = {
      connectError: Object.assign(
        new Error("unable to verify the first certificate"),
        { code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" },
      ),
    };

    IdleWatcherStart(makeConfig(), jest.fn());
    await flushMicrotasks();

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("TLS certificate verification failed"),
      expect.any(Error),
      undefined,
    );
    expect(FakeImapFlow.instances[0].options.tls).toBeUndefined();

    jest.advanceTimersByTime(30000);
    await flushMicrotasks();
    expect(FakeImapFlow.instances).toHaveLength(2);
  });
});
