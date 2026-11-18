import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  FEED_SETTINGS_FILE_NAME,
  FeedSettingsFindSenderRule,
  FeedSettingsGet,
  FeedSettingsGetBlockRemoteImages,
  FeedSettingsGetForFeed,
  FeedSettingsGetGeneration,
  FeedSettingsGetMaxItems,
  FeedSettingsGetReferencedFeedIds,
  FeedSettingsGetStripTrackingPixels,
  FeedSettingsInit,
  FeedSettingsIsHidden,
  FeedSettingsReload,
  FeedSettingsResolveMergeTarget,
  FeedSettingsSave,
  FeedSettingsValidationError,
} from "./FeedSettings";

jest.mock("../OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    __mockLogger: logger,
  };
});

const mockLogger = jest.requireMock("../OTelContext").__mockLogger as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};

function initTmp(): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedsettings-"));
  FeedSettingsInit(dataDir);
  return dataDir;
}

function settingsPath(dataDir: string): string {
  return path.join(dataDir, FEED_SETTINGS_FILE_NAME);
}

function readSettingsFile(dataDir: string): unknown {
  return JSON.parse(fs.readFileSync(settingsPath(dataDir), "utf8"));
}

function writeSettingsFile(dataDir: string, value: unknown): void {
  fs.writeFileSync(settingsPath(dataDir), JSON.stringify(value));
}

function expectValidationError(fn: () => void): string[] {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FeedSettingsValidationError);
    return (err as FeedSettingsValidationError).errors;
  }
  throw new Error("expected FeedSettingsValidationError");
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("FeedSettingsSave", () => {
  it("normalizes, persists and applies a document", () => {
    const dataDir = initTmp();
    const generationBefore = FeedSettingsGetGeneration();

    FeedSettingsSave({
      version: 1,
      feeds: {
        daily: {
          title: "  The   Daily\n",
          hidden: true,
          maxItems: 5,
          blockRemoteImages: false,
          stripTrackingPixels: true,
          mergeInto: "all",
        },
        all: {},
      },
      senders: {
        "  News@Example.com ": { feedId: "daily", title: "Daily News" },
      },
    });

    expect(FeedSettingsGetGeneration()).toBe(generationBefore + 1);
    expect(FeedSettingsGet()).toEqual({
      version: 1,
      feeds: {
        all: {},
        daily: {
          title: "The Daily",
          hidden: true,
          maxItems: 5,
          blockRemoteImages: false,
          stripTrackingPixels: true,
          mergeInto: "all",
        },
      },
      senders: { "news@example.com": { feedId: "daily", title: "Daily News" } },
    });
    expect(readSettingsFile(dataDir)).toEqual(FeedSettingsGet());
  });

  it("does not bump the generation when the normalized document is unchanged", () => {
    const dataDir = initTmp();
    const document = { version: 1, feeds: { daily: { title: "Daily" } } };
    FeedSettingsSave(document);
    const generation = FeedSettingsGetGeneration();
    FeedSettingsSave(document);
    expect(FeedSettingsGetGeneration()).toBe(generation);
    expect(fs.existsSync(settingsPath(dataDir))).toBe(true);
  });

  it("rejects invalid feed ids, values and merge cycles with field paths", () => {
    const dataDir = initTmp();
    const errors = expectValidationError(() =>
      FeedSettingsSave({
        version: 1,
        feeds: {
          "Bad.Id": {},
          daily: {
            title: 42,
            hidden: "yes",
            maxItems: -1,
            mergeInto: "daily",
          },
          a: { mergeInto: "b" },
          b: { mergeInto: "a" },
        },
        senders: {
          "": { feedId: "daily" },
          "NEWS@example.com": { feedId: "daily" },
          "news@example.com": { feedId: "daily" },
          "promo@example.com": { feedId: "nope!" },
        },
      }),
    );

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("feeds.Bad.Id: invalid feed id"),
        expect.stringContaining("feeds.daily.title: must be a string"),
        expect.stringContaining("feeds.daily.hidden: must be a boolean"),
        expect.stringContaining("feeds.daily.maxItems: must be a non-negative integer"),
        expect.stringContaining("feeds.daily.mergeInto: a feed cannot merge into itself"),
        expect.stringContaining("merge cycle"),
        expect.stringContaining("duplicate sender match"),
        expect.stringContaining("sender match must not be empty"),
        expect.stringContaining(
          "senders.promo@example.com.feedId: must be a valid feed id",
        ),
      ]),
    );
    // A rejected save leaves the in-memory settings and the file untouched.
    expect(FeedSettingsGet().feeds).toEqual({});
    expect(fs.existsSync(settingsPath(dataDir))).toBe(false);
  });

  it("rejects an unsupported version and a non-object document", () => {
    initTmp();
    expect(expectValidationError(() => FeedSettingsSave([]))).toEqual([
      "document: must be a JSON object",
    ]);
    expect(
      expectValidationError(() =>
        FeedSettingsSave({ version: 2, feeds: {} }),
      ),
    ).toEqual(["version: must be 1"]);
  });
});

describe("FeedSettings reload", () => {
  it("loads a valid file at init and reloads hand edits", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedsettings-"));
    writeSettingsFile(dataDir, {
      version: 1,
      feeds: { daily: { title: "Daily" } },
    });
    FeedSettingsInit(dataDir);
    expect(FeedSettingsGetForFeed("daily")).toEqual({ title: "Daily" });

    writeSettingsFile(dataDir, {
      version: 1,
      feeds: { daily: { title: "Daily", hidden: true }, weekly: {} },
    });
    expect(FeedSettingsReload()).toBe(true);
    expect(FeedSettingsIsHidden("daily")).toBe(true);
    expect(FeedSettingsGetForFeed("weekly")).toEqual({});
  });

  it("returns false and keeps the previous settings for invalid JSON", () => {
    const dataDir = initTmp();
    FeedSettingsSave({ version: 1, feeds: { daily: { title: "Daily" } } });
    fs.writeFileSync(settingsPath(dataDir), "{ not json");

    expect(FeedSettingsReload()).toBe(false);
    expect(FeedSettingsGetForFeed("daily")).toEqual({ title: "Daily" });
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("keeping the previous settings"),
    );
  });

  it("drops invalid entries and fields from a hand-edited file", () => {
    const dataDir = initTmp();
    writeSettingsFile(dataDir, {
      version: 1,
      feeds: {
        "bad.id": { title: "Bad" },
        daily: { title: 7, hidden: true, maxItems: 3.5, mergeInto: "daily" },
        weekly: { hidden: "no" },
      },
      senders: {
        "": { feedId: "daily" },
        "news@example.com": { feedId: "not valid", title: "News" },
      },
    });
    FeedSettingsInit(dataDir);

    expect(FeedSettingsGetForFeed("bad.id")).toBeUndefined();
    expect(FeedSettingsGetForFeed("daily")).toEqual({ hidden: true });
    expect(FeedSettingsGetForFeed("weekly")).toEqual({});
    expect(FeedSettingsGetForFeed("bad.id")).toBeUndefined();
    expect(FeedSettingsGetReferencedFeedIds()).toEqual(["daily", "weekly"]);
    expect(FeedSettingsFindSenderRule("", "news@example.com")).toEqual({
      title: "News",
    });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("keeps the previous settings when the file has an unsupported version", () => {
    const dataDir = initTmp();
    FeedSettingsSave({ version: 1, feeds: { daily: { title: "Daily" } } });
    writeSettingsFile(dataDir, { version: 99, feeds: {} });
    expect(FeedSettingsReload()).toBe(false);
    expect(FeedSettingsGetForFeed("daily")).toEqual({ title: "Daily" });
  });

  it("accepts an unchanged file without bumping the generation", () => {
    initTmp();
    FeedSettingsSave({ version: 1, feeds: { daily: { title: "Daily" } } });
    const generation = FeedSettingsGetGeneration();
    expect(FeedSettingsReload()).toBe(true);
    expect(FeedSettingsGetGeneration()).toBe(generation);
  });

  it("resets to empty settings when the file is deleted", () => {
    const dataDir = initTmp();
    FeedSettingsSave({ version: 1, feeds: { daily: { hidden: true } } });
    fs.unlinkSync(settingsPath(dataDir));
    expect(FeedSettingsReload()).toBe(true);
    expect(FeedSettingsGet().feeds).toEqual({});
  });

  it("keeps settings across re-init with the same data dir and resets for a new one", () => {
    const dataDir = initTmp();
    FeedSettingsSave({ version: 1, feeds: { daily: { hidden: true } } });
    FeedSettingsInit(dataDir);
    expect(FeedSettingsIsHidden("daily")).toBe(true);

    const other = fs.mkdtempSync(path.join(os.tmpdir(), "feedsettings-"));
    FeedSettingsInit(other);
    expect(FeedSettingsIsHidden("daily")).toBe(false);
  });
});

describe("feed getters", () => {
  it("applies per-feed overrides and falls back to the environment values", () => {
    initTmp();
    FeedSettingsSave({
      version: 1,
      feeds: {
        daily: {
          maxItems: 0,
          stripTrackingPixels: false,
          blockRemoteImages: true,
        },
        weekly: {},
      },
    });
    expect(FeedSettingsGetMaxItems("daily", 200)).toBe(0);
    expect(FeedSettingsGetMaxItems("weekly", 200)).toBe(200);
    expect(FeedSettingsGetStripTrackingPixels("daily", true)).toBe(false);
    expect(FeedSettingsGetStripTrackingPixels("weekly", true)).toBe(true);
    expect(FeedSettingsGetBlockRemoteImages("daily", false)).toBe(true);
    expect(FeedSettingsGetBlockRemoteImages("weekly", false)).toBe(false);
    expect(FeedSettingsGetForFeed("unknown")).toBeUndefined();
    expect(FeedSettingsIsHidden("unknown")).toBe(false);
  });

  it("returns defensive copies", () => {
    initTmp();
    FeedSettingsSave({ version: 1, feeds: { daily: { title: "Daily" } } });
    const copy = FeedSettingsGet();
    copy.feeds.daily.title = "Mutated";
    expect(FeedSettingsGetForFeed("daily")).toEqual({ title: "Daily" });
  });
});

describe("sender rules and merge resolution", () => {
  it("matches the email before the name, case-insensitively", () => {
    initTmp();
    FeedSettingsSave({
      version: 1,
      feeds: {},
      senders: {
        "news@example.com": { feedId: "news" },
        "the daily": { feedId: "daily" },
      },
    });
    expect(
      FeedSettingsFindSenderRule("The Daily", "NEWS@example.com"),
    ).toEqual({ feedId: "news" });
    expect(FeedSettingsFindSenderRule("THE DAILY", "other@example.com")).toEqual(
      { feedId: "daily" },
    );
    expect(
      FeedSettingsFindSenderRule("Other", "other@example.com"),
    ).toBeUndefined();
  });

  it("resolves transitive merges and stops at cycles or self references", () => {
    initTmp();
    FeedSettingsSave({
      version: 1,
      feeds: {
        a: { mergeInto: "b" },
        b: { mergeInto: "c" },
        c: {},
      },
    });
    expect(FeedSettingsResolveMergeTarget("a")).toBe("c");
    expect(FeedSettingsResolveMergeTarget("b")).toBe("c");
    expect(FeedSettingsResolveMergeTarget("c")).toBe("c");
    expect(FeedSettingsResolveMergeTarget("unknown")).toBe("unknown");

    // Cycles are rejected on write but sanitized defensively on read.
    FeedSettingsInit(fs.mkdtempSync(path.join(os.tmpdir(), "feedsettings-")));
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedsettings-"));
    writeSettingsFile(dataDir, {
      version: 1,
      feeds: { x: { mergeInto: "y" }, y: { mergeInto: "x" } },
    });
    FeedSettingsInit(dataDir);
    expect(["x", "y"]).toContain(FeedSettingsResolveMergeTarget("x"));
  });

  it("lists every base feed, merge target and sender target", () => {
    initTmp();
    FeedSettingsSave({
      version: 1,
      feeds: {
        daily: { mergeInto: "everything" },
        weekly: {},
      },
      senders: {
        "news@example.com": { feedId: "daily" },
        "promo@example.com": {},
      },
    });
    expect(FeedSettingsGetReferencedFeedIds()).toEqual([
      "daily",
      "everything",
      "weekly",
    ]);
  });
});
