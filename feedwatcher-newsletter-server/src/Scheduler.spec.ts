import { Span } from "@opentelemetry/api";
import * as schedule from "node-schedule";
import { Config } from "./Config";
import { SchedulerInit, SchedulerReload } from "./Scheduler";
import { EmailFetcherFetchEmails } from "./emails/EmailFetcher";
import { IdleWatcherStart } from "./emails/IdleWatcher";
import {
  EmailsDataPurgeExpired,
  EmailsDataSetRetentionDays,
  EmailFeedsListAll,
} from "./emails/EmailsData";
import { FeedIdentityInit, FeedIdentityPruneTokens } from "./feeds/FeedIdentity";
import { TimeoutWait } from "./utils-std-ts/Timeout";

jest.mock("./emails/EmailFetcher", () => ({
  EmailFetcherFetchEmails: jest.fn(),
}));
jest.mock("./emails/IdleWatcher", () => ({
  IdleWatcherStart: jest.fn(),
}));
jest.mock("./emails/EmailsData", () => ({
  EmailsDataInit: jest.fn(),
  EmailsDataPurgeExpired: jest.fn(),
  EmailsDataSetRetentionDays: jest.fn(),
  EmailFeedsListAll: jest.fn(),
}));
jest.mock("./feeds/FeedIdentity", () => ({
  FeedIdentityEnsureTokens: jest.fn(),
  FeedIdentityInit: jest.fn(),
  FeedIdentityGetFeedUrlId: jest.fn(),
  FeedIdentityPruneTokens: jest.fn(),
}));
jest.mock("node-schedule", () => ({
  scheduleJob: jest.fn(),
}));
jest.mock("./utils-std-ts/Timeout", () => ({
  TimeoutWait: jest.fn(),
}));
jest.mock("./ServerStatus", () => ({
  ServerStatusRecordFetchSuccess: jest.fn(),
  ServerStatusRecordFetchError: jest.fn(),
}));
jest.mock("./OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const startSpan = jest.fn();
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    OTelTracer: () => ({ startSpan }),
    __mockLogger: logger,
    __startSpan: startSpan,
  };
});

const fetchMock = EmailFetcherFetchEmails as unknown as jest.Mock;
const idleStartMock = IdleWatcherStart as unknown as jest.Mock;
const scheduleJobMock = schedule.scheduleJob as unknown as jest.Mock;
const feedsMock = EmailFeedsListAll as unknown as jest.Mock;
const pruneTokensMock = FeedIdentityPruneTokens as unknown as jest.Mock;
const ensureTokensMock = jest.requireMock("./feeds/FeedIdentity")
  .FeedIdentityEnsureTokens as jest.Mock;
const timeoutMock = TimeoutWait as unknown as jest.Mock;
const mockLogger = jest.requireMock("./OTelContext").__mockLogger;
const startSpanMock = jest.requireMock("./OTelContext").__startSpan as jest.Mock;
const recordSuccessMock = jest.requireMock("./ServerStatus")
  .ServerStatusRecordFetchSuccess as jest.Mock;
const recordErrorMock = jest.requireMock("./ServerStatus")
  .ServerStatusRecordFetchError as jest.Mock;

function makeConfig(overrides: Partial<Config> = {}): Config {
  return Object.assign(new Config(), {
    IMAP_HOST: "imap.example.com",
    IMAP_USER: "newsletter@example.com",
    IMAP_PASSWORD: "secret",
    EMAIL_FETCH_CRON: "0 * * * *",
    EMAIL_FETCH_IDLE: true,
    EMAIL_FETCH_RETRIES: 2,
    EMAIL_FETCH_RETRY_DELAY_MS: 10000,
    ...overrides,
  });
}

function makeSpan(): Span {
  return { end: jest.fn() } as unknown as Span;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: Error) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (err: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

beforeEach(() => {
  jest.resetAllMocks();
  startSpanMock.mockImplementation(() => ({ end: jest.fn() }));
  fetchMock.mockResolvedValue(undefined);
  feedsMock.mockReturnValue([]);
  timeoutMock.mockResolvedValue(undefined);
  scheduleJobMock.mockImplementation(() => ({ cancel: jest.fn() }));
  (jest.requireMock("./feeds/FeedIdentity").FeedIdentityGetFeedUrlId as jest.Mock).mockReturnValue("feed");
});

describe("SchedulerInit", () => {
  it("runs a single fetch when startup, cron and IDLE triggers overlap", async () => {
    const startupFetch = deferred();
    fetchMock.mockReturnValueOnce(startupFetch.promise);

    await SchedulerInit(makeSpan(), makeConfig());

    const idleCallback = idleStartMock.mock.calls[0][1];
    const cronCallback = scheduleJobMock.mock.calls[0][1];
    expect(fetchMock).toHaveBeenCalledTimes(1);

    idleCallback();
    cronCallback();
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    startupFetch.resolve();
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Once the in-flight run is over, the next trigger fetches again.
    const nextFetch = deferred();
    fetchMock.mockReturnValueOnce(nextFetch.promise);
    idleCallback();
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    nextFetch.resolve();
    await flushAsync();
  });

  it("purges before the cron fetch", async () => {
    await SchedulerInit(makeSpan(), makeConfig());
    const cronCallback = scheduleJobMock.mock.calls[0][1];
    await flushAsync();
    fetchMock.mockClear();
    (EmailsDataPurgeExpired as unknown as jest.Mock).mockClear();

    cronCallback();
    await flushAsync();

    expect(EmailsDataPurgeExpired).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the retry/backoff behaviour", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("first failure"))
      .mockRejectedValueOnce(new Error("second failure"))
      .mockResolvedValueOnce(undefined);

    await SchedulerInit(
      makeSpan(),
      makeConfig({ EMAIL_FETCH_RETRIES: 2, EMAIL_FETCH_RETRY_DELAY_MS: 1234 }),
    );
    await flushAsync();

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(timeoutMock).toHaveBeenCalledTimes(2);
    expect(timeoutMock).toHaveBeenCalledWith(1234);
  });

  it("prunes feed tokens for the feeds present at startup", async () => {
    feedsMock.mockReturnValue([
      {
        feedId: "daily",
        title: "The Daily",
        senderName: "The Daily",
        senderEmail: "news@example.com",
        itemCount: 1,
        latestDate: "2026-10-15T08:00:00.000Z",
      },
    ]);

    await SchedulerInit(makeSpan(), makeConfig());

    expect(pruneTokensMock).toHaveBeenCalledWith(["daily"]);
  });
});

describe("SchedulerReload", () => {
  it("applies retention, cron, IDLE and feed identity", async () => {
    await SchedulerInit(makeSpan(), makeConfig());
    await flushAsync();
    const initialJob = scheduleJobMock.mock.results[0].value;
    const nextJob = { cancel: jest.fn() };
    scheduleJobMock.mockReturnValueOnce(nextJob);

    SchedulerReload(
      makeConfig({
        EMAIL_RETENTION_DAYS: 5,
        EMAIL_FETCH_CRON: "*/5 * * * *",
        SENDER_IGNORE_LIST: "billing",
        FEED_PRIVATE_URLS_STRICT: true,
      }),
    );

    expect(EmailsDataSetRetentionDays).toHaveBeenCalledWith(5);
    expect(scheduleJobMock).toHaveBeenCalledTimes(2);
    expect(scheduleJobMock).toHaveBeenLastCalledWith(
      "*/5 * * * *",
      expect.any(Function),
    );
    expect(initialJob.cancel).toHaveBeenCalledTimes(1);
    expect(idleStartMock).toHaveBeenCalledTimes(2);
    expect(FeedIdentityInit).toHaveBeenCalledTimes(2);
    expect(FeedIdentityInit).toHaveBeenLastCalledWith(
      expect.objectContaining({
        ignoreList: "billing",
        privateUrlsStrict: true,
      }),
    );
  });

  it("keeps the previous schedule when the new cron expression is invalid", async () => {
    await SchedulerInit(makeSpan(), makeConfig());
    await flushAsync();
    const initialJob = scheduleJobMock.mock.results[0].value;
    scheduleJobMock.mockImplementationOnce(() => {
      throw new Error("Invalid cron expression");
    });

    SchedulerReload(makeConfig({ EMAIL_FETCH_CRON: "not-a-cron" }));

    expect(initialJob.cancel).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalled();
  });

  it("does not reschedule when the cron expression is unchanged", async () => {
    await SchedulerInit(makeSpan(), makeConfig());
    await flushAsync();

    SchedulerReload(makeConfig());

    expect(scheduleJobMock).toHaveBeenCalledTimes(1);
  });

  it("warns about restart-only changes", async () => {
    await SchedulerInit(makeSpan(), makeConfig());
    await flushAsync();

    const config = makeConfig();
    config.IMAP_HOST = "new-host.example.com";
    SchedulerReload(config);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("IMAP_HOST"),
    );
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("IMAP_PASSWORD"),
    );
  });

  it("warns when the IMAP TLS settings change", async () => {
    await SchedulerInit(makeSpan(), makeConfig());
    await flushAsync();

    const config = makeConfig();
    config.IMAP_TLS_INSECURE = true;
    config.IMAP_TLS_CA_FILE = "/certs/private-ca.pem";
    SchedulerReload(config);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "IMAP_TLS_INSECURE, IMAP_TLS_CA_FILE",
      ),
    );
  });
});

describe("startup fetch span and fetch health", () => {
  it("starts a root span that outlives SchedulerInit and ends when the fetch settles", async () => {
    const startupFetch = deferred();
    fetchMock.mockReturnValueOnce(startupFetch.promise);
    const initSpan = makeSpan();

    await SchedulerInit(initSpan, makeConfig());

    expect(startSpanMock.mock.calls.map((call) => call[0])).toEqual([
      "SchedulerInit",
      "StartupEmailFetch",
    ]);
    // The startup fetch span is a root span: no parent argument.
    expect(startSpanMock.mock.calls[1]).toEqual(["StartupEmailFetch"]);
    // The SchedulerInit span ends as soon as init returns...
    const schedulerSpan = startSpanMock.mock.results[0].value;
    expect(schedulerSpan.end).toHaveBeenCalledTimes(1);
    const startupSpan = startSpanMock.mock.results[1].value;
    expect(startupSpan.end).not.toHaveBeenCalled();

    // ...but the startup span only ends once the background fetch settles.
    startupFetch.resolve();
    await flushAsync();
    expect(startupSpan.end).toHaveBeenCalledTimes(1);
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
    expect(recordErrorMock).not.toHaveBeenCalled();
  });

  it("ends the startup span and records a single error when the fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("imap down"));

    await SchedulerInit(makeSpan(), makeConfig({ EMAIL_FETCH_RETRIES: 0 }));
    await flushAsync();

    const startupSpan = startSpanMock.mock.results[1].value;
    expect(startupSpan.end).toHaveBeenCalledTimes(1);
    expect(recordErrorMock).toHaveBeenCalledTimes(1);
    expect(recordErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ message: "imap down" }),
    );
    expect(recordSuccessMock).not.toHaveBeenCalled();
  });

  it("records no fetch health for a skipped trigger", async () => {
    const startupFetch = deferred();
    fetchMock.mockReturnValueOnce(startupFetch.promise);
    await SchedulerInit(makeSpan(), makeConfig());
    const cronCallback = scheduleJobMock.mock.calls[0][1];

    cronCallback();
    await flushAsync();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordSuccessMock).not.toHaveBeenCalled();
    expect(recordErrorMock).not.toHaveBeenCalled();

    startupFetch.resolve();
    await flushAsync();
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
  });
});

describe("feed token ensure passes", () => {
  const feed = {
    feedId: "daily",
    title: "The Daily",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    itemCount: 1,
    latestDate: "2026-10-15T08:00:00.000Z",
  };

  it("persists tokens for the startup index and after a successful fetch", async () => {
    feedsMock.mockReturnValue([feed]);

    await SchedulerInit(makeSpan(), makeConfig());
    expect(ensureTokensMock).toHaveBeenCalledTimes(1);
    expect(ensureTokensMock).toHaveBeenLastCalledWith(["daily"]);

    await flushAsync();
    expect(ensureTokensMock).toHaveBeenCalledTimes(2);
    expect(ensureTokensMock).toHaveBeenLastCalledWith(["daily"]);
  });

  it("persists tokens again after a configuration reload", async () => {
    feedsMock.mockReturnValue([feed]);
    await SchedulerInit(makeSpan(), makeConfig());
    await flushAsync();
    ensureTokensMock.mockClear();

    SchedulerReload(makeConfig({ FEED_PRIVATE_URLS: true }));

    expect(ensureTokensMock).toHaveBeenCalledTimes(1);
    expect(ensureTokensMock).toHaveBeenLastCalledWith(["daily"]);
  });

  it("logs a failed ensure pass without failing the fetch", async () => {
    feedsMock.mockReturnValue([feed]);
    ensureTokensMock.mockImplementation(() => {
      throw new Error("disk full");
    });

    await SchedulerInit(makeSpan(), makeConfig());
    await flushAsync();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Unable to persist feed tokens"),
      expect.anything(),
    );
    expect(recordSuccessMock).toHaveBeenCalledTimes(1);
    expect(recordErrorMock).not.toHaveBeenCalled();
  });
});
