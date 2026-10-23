import { Config } from "../Config";
import { IdleWatcherStart, IdleWatcherStop } from "./IdleWatcher";

jest.mock("imap", () => {
  const { EventEmitter: Emitter } = jest.requireActual("events");
  class FakeImap extends Emitter {
    static instances: any[] = [];
    config: any;
    openBoxArgs: any;
    connectCalls = 0;
    destroyCalls = 0;
    constructor(config: any) {
      super();
      this.config = config;
      FakeImap.instances.push(this);
    }
    connect() {
      this.connectCalls++;
      this.emit("ready");
    }
    openBox(name: string, readOnly: boolean, cb: any) {
      this.openBoxArgs = { name, readOnly };
      cb(null, { uidvalidity: 1 });
    }
    destroy() {
      this.destroyCalls++;
      this.emit("close", true);
    }
  }
  return { __esModule: true, default: FakeImap };
});

jest.mock("../OTelContext", () => ({
  OTelLogger: () => ({
    createModuleLogger: () => ({
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    }),
  }),
}));

const FakeImap = jest.requireMock("imap").default;

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

beforeEach(() => {
  jest.useFakeTimers();
  IdleWatcherStop();
  FakeImap.instances.length = 0;
  jest.clearAllMocks();
});

afterEach(() => {
  IdleWatcherStop();
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe("IdleWatcher", () => {
  it("opens one IDLE connection with the IDLE socket timeout", () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    expect(FakeImap.instances).toHaveLength(1);
    const imap = FakeImap.instances[0];
    expect(imap.config.socketTimeout).toBe(600000);
    expect(imap.openBoxArgs).toEqual({ name: "INBOX", readOnly: true });
  });

  it("is idempotent: a second start does not open a second connection", () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    IdleWatcherStart(makeConfig(), jest.fn());
    expect(FakeImap.instances).toHaveLength(1);
  });

  it("does not connect when EMAIL_FETCH_IDLE is disabled", () => {
    IdleWatcherStart(makeConfig({ EMAIL_FETCH_IDLE: false }), jest.fn());
    expect(FakeImap.instances).toHaveLength(0);
  });

  it("destroys the connection on an IMAP error and reconnects after 30s", () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    const imap = FakeImap.instances[0];

    imap.emit("error", new Error("socket reset"));
    expect(imap.destroyCalls).toBe(1);
    expect(FakeImap.instances).toHaveLength(1);

    jest.advanceTimersByTime(29999);
    expect(FakeImap.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeImap.instances).toHaveLength(2);
  });

  it("reconnects after a close with the 30s base delay", () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    FakeImap.instances[0].emit("close", false);

    jest.advanceTimersByTime(29999);
    expect(FakeImap.instances).toHaveLength(1);
    jest.advanceTimersByTime(1);
    expect(FakeImap.instances).toHaveLength(2);
  });

  it("does not reconnect after a stop", () => {
    IdleWatcherStart(makeConfig(), jest.fn());
    FakeImap.instances[0].emit("close", false);

    IdleWatcherStop();
    jest.advanceTimersByTime(3600000);
    expect(FakeImap.instances).toHaveLength(1);
  });

  it("debounces a burst of new-mail notifications into one fetch", () => {
    const triggerFetch = jest.fn();
    IdleWatcherStart(makeConfig(), triggerFetch);
    const imap = FakeImap.instances[0];

    imap.emit("mail", 1);
    jest.advanceTimersByTime(5000);
    imap.emit("mail", 1);
    jest.advanceTimersByTime(9999);
    expect(triggerFetch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(triggerFetch).toHaveBeenCalledTimes(1);
  });
});
