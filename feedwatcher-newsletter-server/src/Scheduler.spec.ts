import { Span } from "@opentelemetry/sdk-trace-base";
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
jest.mock("./OTelContext", () => {
  const span = { end: jest.fn() };
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    OTelTracer: () => ({ startSpan: jest.fn(() => span) }),
    __mockSpan: span,
    __mockLogger: logger,
  };
});

const fetchMock = EmailFetcherFetchEmails as unknown as jest.Mock;
const idleStartMock = IdleWatcherStart as unknown as jest.Mock;
const scheduleJobMock = schedule.scheduleJob as unknown as jest.Mock;
const feedsMock = EmailFeedsListAll as unknown as jest.Mock;
const pruneTokensMock = FeedIdentityPruneTokens as unknown as jest.Mock;
const timeoutMock = TimeoutWait as unknown as jest.Mock;
const mockLogger = jest.requireMock("./OTelContext").__mockLogger;

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
});
