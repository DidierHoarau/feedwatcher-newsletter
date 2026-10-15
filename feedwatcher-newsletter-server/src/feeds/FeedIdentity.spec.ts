import * as fs from "fs";
import * as os from "os";
import path from "path";
import {
  FeedIdentityGetFeedId,
  FeedIdentityGetFeedUrlId,
  FeedIdentityGetTitle,
  FeedIdentityInit,
  FeedIdentityIsSenderIgnored,
  FeedIdentityResolveFeedUrlId,
} from "./FeedIdentity";

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

  it("keeps the token stable across restarts (persisted)", () => {
    const dataDir = initTmp({ privateUrls: true });
    const first = FeedIdentityGetFeedUrlId("daily");
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: true,
      dataDir,
    });
    expect(FeedIdentityGetFeedUrlId("daily")).toBe(first);
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

  it("resolves a valid token URL", () => {
    initTmp({ privateUrls: true });
    const urlId = FeedIdentityGetFeedUrlId("daily");
    expect(FeedIdentityResolveFeedUrlId(urlId)).toEqual({
      feedId: "daily",
      valid: true,
    });
  });

  it("rejects a wrong token", () => {
    initTmp({ privateUrls: true });
    FeedIdentityGetFeedUrlId("daily");
    const resolved = FeedIdentityResolveFeedUrlId("daily.000000000000000000000000");
    expect(resolved.feedId).toBe("daily");
    expect(resolved.valid).toBe(false);
  });
});
