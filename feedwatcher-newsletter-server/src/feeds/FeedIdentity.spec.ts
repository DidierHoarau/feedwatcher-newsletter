import { randomBytes } from "crypto";
import * as fs from "fs";
import * as fse from "fs-extra";
import * as os from "os";
import path from "path";
import {
  FeedIdentityEnsureTokens,
  FeedIdentityGetFeedId,
  FeedIdentityGetFeedUrlId,
  FeedIdentityGetTitle,
  FeedIdentityInit,
  FeedIdentityIsSenderIgnored,
  FeedIdentityPruneTokens,
  FeedIdentityResolveFeedUrlId,
} from "./FeedIdentity";

jest.mock("../OTelContext", () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return {
    OTelLogger: () => ({ createModuleLogger: () => logger }),
    __mockLogger: logger,
  };
});

// Partial mock: real filesystem everywhere, but renameSync is observable so
// the atomic tmp + rename protocol and the persist count can be asserted.
jest.mock("fs-extra", () => {
  const actual = jest.requireActual("fs-extra");
  return {
    ...actual,
    renameSync: jest.fn(actual.renameSync),
  };
});

const mockLogger = jest.requireMock("../OTelContext").__mockLogger as {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
};
const renameMock = fse.renameSync as unknown as jest.Mock;

function initTmp(
  options: Partial<Parameters<typeof FeedIdentityInit>[0]> = {},
): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "feedidentity-"));
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
    ...options,
  });
  return dataDir;
}

function tokensPathOf(dataDir: string): string {
  return path.join(dataDir, "feed-tokens.json");
}

function readTokenFile(dataDir: string): Record<string, string> {
  return JSON.parse(fs.readFileSync(tokensPathOf(dataDir), "utf8"));
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("FeedIdentityGetFeedId", () => {
  it("derives the id from the sender name", () => {
    initTmp();
    expect(
      FeedIdentityGetFeedId("The Daily Newsletter", "news@example.com"),
    ).toBe("thedailynewsletter");
  });

  it("uses the override feedId matched by sender email", () => {
    initTmp({
      overrides: { "news@example.com": { feedId: "daily" } },
    });
    expect(FeedIdentityGetFeedId("Whatever Name", "news@example.com")).toBe(
      "daily",
    );
  });

  it("uses the override feedId matched by sender name, case-insensitively", () => {
    initTmp({
      overrides: { "scmp news": { feedId: "scmp" } },
    });
    expect(FeedIdentityGetFeedId("SCMP News", "alerts@scmp.com")).toBe("scmp");
  });
});

describe("FeedIdentityGetFeedId — names without Latin characters", () => {
  it("derives stable sender-<hash8> ids for non-Latin and emoji-only names", () => {
    initTmp();
    const names = ["中文日报", "Новости", "الأخبار", "📰📬"];
    const ids = names.map((name) =>
      FeedIdentityGetFeedId(name, "sender@example.com"),
    );
    for (const id of ids) {
      expect(id).toMatch(/^sender-[0-9a-f]{8}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the fallback id stable across calls and re-inits", () => {
    const dataDir = initTmp();
    const first = FeedIdentityGetFeedId("中文日报", "news@scmp.com");
    expect(FeedIdentityGetFeedId("中文日报", "other@example.com")).toBe(first);

    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: false,
      dataDir,
    });

    expect(FeedIdentityGetFeedId("中文日报", "news@scmp.com")).toBe(first);
  });

  it("does not merge two non-Latin senders", () => {
    initTmp();
    const chinese = FeedIdentityGetFeedId("中文日报", "cn@example.com");
    const russian = FeedIdentityGetFeedId("Новости", "ru@example.com");
    expect(chinese).not.toBe(russian);
  });

  it("returns a tokenized URL that round-trips for a fallback id", () => {
    const dataDir = initTmp({ privateUrls: true });
    const feedId = FeedIdentityGetFeedId("中文日报", "news@example.com");
    FeedIdentityEnsureTokens([feedId]);

    const urlId = FeedIdentityGetFeedUrlId(feedId);
    expect(urlId.startsWith(".")).toBe(false);
    expect(urlId).toBe(`${feedId}.${readTokenFile(dataDir)[feedId]}`);
    expect(FeedIdentityResolveFeedUrlId(urlId)).toEqual({
      feedId,
      valid: true,
    });
  });
});

describe("FeedIdentity overrides validation", () => {
  it("rejects invalid feed ids with a warning and keeps the derived id", () => {
    initTmp({
      overrides: {
        "a@example.com": { feedId: "daily.news", title: "Dotted" },
        "b@example.com": { feedId: "Daily" },
        "c@example.com": { feedId: "" },
        "d@example.com": { feedId: "daily/news" },
        "e@example.com": { feedId: 42 as unknown as string },
      },
    });

    expect(FeedIdentityGetFeedId("Sender A", "a@example.com")).toBe("sendera");
    expect(FeedIdentityGetFeedId("Sender B", "b@example.com")).toBe("senderb");
    expect(FeedIdentityGetFeedId("Sender C", "c@example.com")).toBe("senderc");
    expect(FeedIdentityGetFeedId("Sender D", "d@example.com")).toBe("senderd");
    expect(FeedIdentityGetFeedId("Sender E", "e@example.com")).toBe("sendere");

    // Only the invalid feedId is dropped: the title is still applied.
    expect(FeedIdentityGetTitle("Sender A", "a@example.com")).toBe("Dotted");
    expect(mockLogger.warn).toHaveBeenCalledTimes(5);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("daily.news"),
    );
  });

  it("keeps a valid hyphenated override and warns about non-object values", () => {
    initTmp({
      overrides: {
        "a@example.com": { feedId: "daily-2" },
        "b@example.com": null as unknown as { feedId?: string },
      },
    });

    expect(FeedIdentityGetFeedId("Sender A", "a@example.com")).toBe("daily-2");
    expect(FeedIdentityGetFeedId("Sender B", "b@example.com")).toBe("senderb");
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("b@example.com"),
    );
  });
});

describe("FeedIdentityGetTitle", () => {
  it("returns the sender name when no override title exists", () => {
    initTmp();
    expect(FeedIdentityGetTitle("The Daily", "news@example.com")).toBe(
      "The Daily",
    );
  });

  it("returns the override title", () => {
    initTmp({
      overrides: { "news@example.com": { title: "The Daily Newsletter" } },
    });
    expect(FeedIdentityGetTitle("The Daily", "news@example.com")).toBe(
      "The Daily Newsletter",
    );
  });
});

describe("FeedIdentityIsSenderIgnored", () => {
  it("matches terms against sender name and email, case-insensitively", () => {
    initTmp({ ignoreList: "billing, no-reply@shop.com" });
    expect(FeedIdentityIsSenderIgnored("Billing Team", "care@shop.com")).toBe(
      true,
    );
    expect(
      FeedIdentityIsSenderIgnored("Shop Orders", "no-reply@shop.com"),
    ).toBe(true);
    expect(FeedIdentityIsSenderIgnored("The Daily", "news@daily.com")).toBe(
      false,
    );
  });

  it("ignores nothing when the list is empty", () => {
    initTmp({ ignoreList: "" });
    expect(
      FeedIdentityIsSenderIgnored("Billing Team", "billing@shop.com"),
    ).toBe(false);
  });
});

describe("FeedIdentityGetFeedUrlId", () => {
  it("returns the bare feed id when private URLs are disabled", () => {
    initTmp({ privateUrls: false });
    expect(FeedIdentityGetFeedUrlId("daily")).toBe("daily");
  });

  it("returns feedId.token when private URLs are enabled", () => {
    initTmp({ privateUrls: true });
    const urlId = FeedIdentityGetFeedUrlId("daily");
    expect(urlId).toMatch(/^daily\.[0-9a-f]{24}$/);
  });

  it("does not write feed-tokens.json on a URL build (listing path)", () => {
    const dataDir = initTmp({ privateUrls: true });

    const first = FeedIdentityGetFeedUrlId("daily");
    expect(fs.existsSync(tokensPathOf(dataDir))).toBe(false);
    expect(FeedIdentityGetFeedUrlId("daily")).toBe(first);
    expect(fs.existsSync(tokensPathOf(dataDir))).toBe(false);
    expect(renameMock).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("keeps the token stable across restarts (persisted by an ensure pass)", () => {
    const dataDir = initTmp({ privateUrls: true });
    const first = FeedIdentityGetFeedUrlId("daily");
    FeedIdentityEnsureTokens(["daily"]);
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: true,
      dataDir,
    });
    expect(FeedIdentityGetFeedUrlId("daily")).toBe(first);
  });

  it("does not rotate a defensive request-path token on re-init", () => {
    const dataDir = initTmp({ privateUrls: true });
    const defensive = FeedIdentityGetFeedUrlId("daily");
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: true,
      dataDir,
    });
    expect(FeedIdentityGetFeedUrlId("daily")).toBe(defensive);
  });
});

describe("FeedIdentityEnsureTokens", () => {
  it("creates every missing token in one atomic write", () => {
    const dataDir = initTmp({ privateUrls: true });
    renameMock.mockClear();

    FeedIdentityEnsureTokens(["daily", "weekly", "monthly"]);

    expect(renameMock).toHaveBeenCalledTimes(1);
    expect(renameMock).toHaveBeenCalledWith(
      `${tokensPathOf(dataDir)}.tmp`,
      tokensPathOf(dataDir),
    );
    expect(Object.keys(readTokenFile(dataDir)).sort()).toEqual([
      "daily",
      "monthly",
      "weekly",
    ]);
  });

  it("persists a defensive request-path token on the next pass", () => {
    const dataDir = initTmp({ privateUrls: true });
    const defensiveUrlId = FeedIdentityGetFeedUrlId("daily");
    const defensiveToken = defensiveUrlId.slice(defensiveUrlId.indexOf(".") + 1);
    expect(fs.existsSync(tokensPathOf(dataDir))).toBe(false);

    FeedIdentityEnsureTokens(["daily"]);

    expect(readTokenFile(dataDir).daily).toBe(defensiveToken);
  });

  it("does not write when nothing is missing", () => {
    const dataDir = initTmp({ privateUrls: true });
    FeedIdentityEnsureTokens(["daily"]);
    const tokensPath = tokensPathOf(dataDir);
    const before = fs.readFileSync(tokensPath, "utf8");
    const mtime = fs.statSync(tokensPath).mtimeMs;
    renameMock.mockClear();

    FeedIdentityEnsureTokens(["daily"]);

    expect(renameMock).not.toHaveBeenCalled();
    expect(fs.readFileSync(tokensPath, "utf8")).toBe(before);
    expect(fs.statSync(tokensPath).mtimeMs).toBe(mtime);
  });

  it("is a no-op when private URLs are disabled", () => {
    const dataDir = initTmp({ privateUrls: false });
    FeedIdentityEnsureTokens(["daily"]);
    expect(fs.existsSync(tokensPathOf(dataDir))).toBe(false);
  });

  it("keeps the previous file when the atomic rename fails and retries later", () => {
    const dataDir = initTmp({ privateUrls: true });
    FeedIdentityEnsureTokens(["daily"]);
    const tokensPath = tokensPathOf(dataDir);
    const before = fs.readFileSync(tokensPath, "utf8");

    renameMock.mockImplementationOnce(() => {
      throw new Error("simulated rename failure");
    });
    FeedIdentityEnsureTokens(["weekly"]);

    expect(fs.readFileSync(tokensPath, "utf8")).toBe(before);
    expect(fs.existsSync(`${tokensPath}.tmp`)).toBe(false);
    expect(mockLogger.error).toHaveBeenCalled();

    // The in-memory token survives the failure and a later pass persists it.
    FeedIdentityEnsureTokens(["daily", "weekly"]);
    expect(Object.keys(readTokenFile(dataDir)).sort()).toEqual([
      "daily",
      "weekly",
    ]);
  });
});

describe("FeedIdentityResolveFeedUrlId", () => {
  it("resolves bare feed ids (legacy URLs keep working)", () => {
    initTmp({ privateUrls: true });
    expect(FeedIdentityResolveFeedUrlId("daily")).toEqual({
      feedId: "daily",
      valid: true,
    });
  });

  it("rejects bare feed ids in strict private mode", () => {
    initTmp({ privateUrls: true, privateUrlsStrict: true });
    expect(FeedIdentityResolveFeedUrlId("daily")).toEqual({
      feedId: "daily",
      valid: false,
    });
  });

  it("still resolves tokenized URLs in strict private mode", () => {
    initTmp({ privateUrls: true, privateUrlsStrict: true });
    FeedIdentityEnsureTokens(["daily"]);
    const urlId = FeedIdentityGetFeedUrlId("daily");
    expect(FeedIdentityResolveFeedUrlId(urlId)).toEqual({
      feedId: "daily",
      valid: true,
    });
  });

  it("accepts bare feed ids when private URLs are disabled even in strict mode", () => {
    initTmp({ privateUrls: false, privateUrlsStrict: true });
    expect(FeedIdentityResolveFeedUrlId("daily")).toEqual({
      feedId: "daily",
      valid: true,
    });
  });

  it("resolves a valid token URL", () => {
    initTmp({ privateUrls: true });
    FeedIdentityEnsureTokens(["daily"]);
    const urlId = FeedIdentityGetFeedUrlId("daily");
    expect(FeedIdentityResolveFeedUrlId(urlId)).toEqual({
      feedId: "daily",
      valid: true,
    });
  });

  it("rejects a wrong token", () => {
    initTmp({ privateUrls: true });
    FeedIdentityEnsureTokens(["daily"]);
    FeedIdentityGetFeedUrlId("daily");
    const resolved = FeedIdentityResolveFeedUrlId("daily.000000000000000000000000");
    expect(resolved.feedId).toBe("daily");
    expect(resolved.valid).toBe(false);
  });

  it("never creates a token for unknown feed ids (50 probes persist nothing)", () => {
    const dataDir = initTmp({ privateUrls: true });
    const tokensPath = tokensPathOf(dataDir);
    FeedIdentityEnsureTokens(["daily"]);
    const before = fs.readFileSync(tokensPath, "utf8");

    for (let i = 0; i < 50; i++) {
      const probe = `ghost${i}.${randomBytes(12).toString("hex")}`;
      expect(FeedIdentityResolveFeedUrlId(probe).valid).toBe(false);
    }

    expect(fs.readFileSync(tokensPath, "utf8")).toBe(before);
    expect(Object.keys(JSON.parse(fs.readFileSync(tokensPath, "utf8")))).toEqual([
      "daily",
    ]);
  });

  it("does not create feed-tokens.json for unknown ids", () => {
    const dataDir = initTmp({ privateUrls: true });
    expect(FeedIdentityResolveFeedUrlId("ghostfeed.deadbeefdeadbeefdeadbeef")).toEqual({
      feedId: "ghostfeed",
      valid: false,
    });
    expect(fs.existsSync(tokensPathOf(dataDir))).toBe(false);
  });

  it("rejects ids that collide with inherited object properties", () => {
    const dataDir = initTmp({ privateUrls: true });
    expect(() => FeedIdentityResolveFeedUrlId("constructor.toString")).not.toThrow();
    expect(FeedIdentityResolveFeedUrlId("constructor.toString").valid).toBe(false);
    expect(fs.existsSync(tokensPathOf(dataDir))).toBe(false);
  });
});

describe("FeedIdentityPruneTokens", () => {
  it("keeps tokens of existing feeds and removes disappeared ones", () => {
    const dataDir = initTmp({ privateUrls: true });
    FeedIdentityEnsureTokens(["daily", "weekly"]);
    const dailyUrlId = FeedIdentityGetFeedUrlId("daily");
    const tokensPath = tokensPathOf(dataDir);
    expect(Object.keys(JSON.parse(fs.readFileSync(tokensPath, "utf8"))).sort()).toEqual([
      "daily",
      "weekly",
    ]);

    FeedIdentityPruneTokens(["daily"]);

    expect(Object.keys(JSON.parse(fs.readFileSync(tokensPath, "utf8")))).toEqual([
      "daily",
    ]);
    // The kept token still resolves.
    expect(FeedIdentityResolveFeedUrlId(dailyUrlId)).toEqual({
      feedId: "daily",
      valid: true,
    });
  });

  it("does not rewrite the file when nothing is pruned", () => {
    const dataDir = initTmp({ privateUrls: true });
    const tokensPath = tokensPathOf(dataDir);
    FeedIdentityEnsureTokens(["daily"]);
    const mtime = fs.statSync(tokensPath).mtimeMs;

    FeedIdentityPruneTokens(["daily", "other"]);

    expect(fs.statSync(tokensPath).mtimeMs).toBe(mtime);
  });
});
