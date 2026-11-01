import * as fs from "fs";
import * as os from "os";
import path from "path";
import * as fse from "fs-extra";
import {
  EmailsDataInit,
  EmailDataGetUidState,
  EmailDataSetUidState,
  EmailsDataGetFeedLastModified,
  EmailsDataGetLastModified,
  EmailsDataGetRecordCount,
  EmailFeedsListAll,
  EmailItemGetById,
  EmailItemGetEffectiveDateReceived,
  EmailItemsBatchSave,
  EmailItemsGetExistingIds,
  EmailItemsListById,
  EmailSendersListAll,
  EmailsDataPurgeExpired,
} from "./EmailsData";
import { EmailItem } from "./EmailFetcher";
import {
  FeedIdentityEnsureTokens,
  FeedIdentityGetFeedUrlId,
  FeedIdentityInit,
  FeedIdentityResolveFeedUrlId,
} from "../feeds/FeedIdentity";
import {
  SanitizedBodyCacheGet,
  SanitizedBodyCacheStats,
} from "./SanitizedBodyCache";

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

// Partial mock: real fs-extra everywhere, but readSync becomes a controllable
// jest.fn so a journal read error can be simulated.
jest.mock("fs-extra", () => {
  const actual = jest.requireActual("fs-extra");
  return {
    ...actual,
    readSync: jest.fn(actual.readSync),
  };
});

const actualFse = jest.requireActual("fs-extra") as typeof fse;
const readSyncMock = fse.readSync as unknown as jest.Mock;

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  const now = new Date().toISOString();
  const item: EmailItem = {
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
  return item;
}

let dataDir: string;
let journalPath: string;

beforeEach(() => {
  jest.clearAllMocks();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "emailsdata-"));
  journalPath = path.join(dataDir, "emails.jsonl");
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
});

afterEach(() => {
  readSyncMock.mockImplementation(actualFse.readSync);
});

describe("EmailFeedsListAll", () => {
  it("groups items by sender with item counts", () => {
    EmailItemsBatchSave([
      makeItem({ messageId: "<1@example.com>" }),
      makeItem({ messageId: "<2@example.com>" }),
      makeItem({
        messageId: "<3@example.com>",
        senderName: "Morning Brew",
        senderEmail: "brew@morningbrew.com",
      }),
    ]);
    const feeds = EmailFeedsListAll();
    expect(feeds).toHaveLength(2);
    expect(feeds[0].feedId).toBe("morningbrew");
    expect(feeds[0].itemCount).toBe(1);
    expect(feeds[1].feedId).toBe("thedaily");
    expect(feeds[1].itemCount).toBe(2);
  });

  it("merges senders mapped to the same override feedId", () => {
    FeedIdentityInit({
      ignoreList: "",
      overrides: { "alerts@scmp.com": { feedId: "scmp", title: "SCMP" } },
      privateUrls: false,
      dataDir,
    });
    EmailItemsBatchSave([
      makeItem({
        messageId: "<1@example.com>",
        senderName: "SCMP News",
        senderEmail: "alerts@scmp.com",
      }),
      makeItem({
        messageId: "<2@example.com>",
        senderName: "SCMP",
        senderEmail: "scmp@scmp.com",
      }),
    ]);
    const feeds = EmailFeedsListAll();
    expect(feeds).toHaveLength(1);
    expect(feeds[0].feedId).toBe("scmp");
    expect(feeds[0].title).toBe("SCMP");
  });

  it("orders feeds by title with a feedId tie-break", () => {
    FeedIdentityInit({
      ignoreList: "",
      overrides: {
        "alpha@example.com": { feedId: "m", title: "Alpha" },
        "same-a@example.com": { feedId: "a", title: "Same" },
        "same-z@example.com": { feedId: "z", title: "Same" },
      },
      privateUrls: false,
      dataDir,
    });
    EmailItemsBatchSave([
      makeItem({
        messageId: "<z@example.com>",
        senderName: "Sender Z",
        senderEmail: "same-z@example.com",
      }),
      makeItem({
        messageId: "<m@example.com>",
        senderName: "Sender M",
        senderEmail: "alpha@example.com",
      }),
      makeItem({
        messageId: "<a@example.com>",
        senderName: "Sender A",
        senderEmail: "same-a@example.com",
      }),
    ]);
    expect(EmailFeedsListAll().map((feed) => [feed.title, feed.feedId])).toEqual([
      ["Alpha", "m"],
      ["Same", "a"],
      ["Same", "z"],
    ]);
  });

  it("skips unknown senders and ignored senders", () => {
    FeedIdentityInit({
      ignoreList: "billing",
      overrides: {},
      privateUrls: false,
      dataDir,
    });
    EmailItemsBatchSave([
      makeItem({
        messageId: "<1@example.com>",
        senderName: "Unknown",
        senderEmail: "unknown@unknown.com",
      }),
      makeItem({
        messageId: "<2@example.com>",
        senderName: "Billing Team",
        senderEmail: "billing@shop.com",
      }),
      makeItem({ messageId: "<3@example.com>" }),
    ]);
    const feeds = EmailFeedsListAll();
    expect(feeds).toHaveLength(1);
    expect(feeds[0].feedId).toBe("thedaily");
  });
});

describe("EmailItemGetById", () => {
  it("finds an email by its item id", () => {
    EmailItemsBatchSave([makeItem()]);
    expect(EmailItemGetById("aaaaaaaa-1111-4111-8111-111111111111")).toBeDefined();
    expect(EmailItemGetById("bbbbbbbb-1111-4111-8111-111111111111")).toBeUndefined();
  });
});

describe("in-memory index", () => {
  const firstId = "aaaaaaaa-1111-4111-8111-111111111111";
  const replacementId = "bbbbbbbb-1111-4111-8111-111111111111";

  it("serves a saved batch immediately from the index (write-through)", () => {
    EmailItemsBatchSave([
      makeItem({ messageId: "<first@example.com>" }),
      makeItem({
        id: "cccccccc-1111-4111-8111-111111111111",
        messageId: "<brew@example.com>",
        senderName: "Morning Brew",
        senderEmail: "brew@morningbrew.com",
      }),
    ]);
    expect(
      EmailFeedsListAll().map((feed) => [feed.feedId, feed.itemCount]),
    ).toEqual([
      ["morningbrew", 1],
      ["thedaily", 1],
    ]);
    expect(EmailItemsListById("thedaily").map((item) => item.id)).toEqual([
      firstId,
    ]);
    expect(EmailItemGetById(firstId)?.messageId).toBe("<first@example.com>");
  });

  it("replaces a re-saved message: the old item id no longer resolves", () => {
    EmailItemsBatchSave([makeItem({ messageId: "<resave@example.com>" })]);
    EmailItemsBatchSave([
      makeItem({
        id: replacementId,
        messageId: "<resave@example.com>",
        subject: "Updated",
      }),
    ]);
    expect(EmailItemsListById("thedaily").map((item) => item.id)).toEqual([
      replacementId,
    ]);
    expect(EmailItemGetById(firstId)).toBeUndefined();
    expect(EmailItemGetById(replacementId)?.subject).toBe("Updated");
    expect(EmailItemsGetExistingIds()).toEqual(new Set(["<resave@example.com>"]));
  });

  it("serves all reads without touching the journal once warm", () => {
    EmailItemsBatchSave([makeItem()]);
    const movedPath = `${journalPath}.moved`;
    fs.renameSync(journalPath, movedPath);
    try {
      expect(EmailFeedsListAll()).toHaveLength(1);
      expect(EmailItemsListById("thedaily")).toHaveLength(1);
      expect(EmailItemGetById("aaaaaaaa-1111-4111-8111-111111111111")).toBeDefined();
      expect(EmailItemsGetExistingIds()).toEqual(new Set(["<msg-1@example.com>"]));
      expect(EmailSendersListAll()).toEqual([
        { senderName: "The Daily", senderEmail: "news@example.com" },
      ]);
    } finally {
      fs.renameSync(movedPath, journalPath);
    }
  });

  it("rebuilds listings after a feed-identity change without reading the journal", () => {
    EmailItemsBatchSave([
      makeItem(),
      makeItem({
        id: "cccccccc-1111-4111-8111-111111111111",
        messageId: "<brew@example.com>",
        senderName: "Morning Brew",
        senderEmail: "brew@morningbrew.com",
      }),
    ]);
    expect(EmailFeedsListAll().map((feed) => feed.feedId)).toEqual([
      "morningbrew",
      "thedaily",
    ]);
    const movedPath = `${journalPath}.moved`;
    fs.renameSync(journalPath, movedPath);
    try {
      FeedIdentityInit({
        ignoreList: "brew",
        overrides: {},
        privateUrls: false,
        dataDir,
      });
      expect(EmailFeedsListAll().map((feed) => feed.feedId)).toEqual([
        "thedaily",
      ]);
      expect(EmailItemsListById("morningbrew")).toHaveLength(0);

      FeedIdentityInit({
        ignoreList: "",
        overrides: { "brew@morningbrew.com": { feedId: "brew", title: "Brew" } },
        privateUrls: false,
        dataDir,
      });
      expect(EmailFeedsListAll().map((feed) => feed.feedId)).toEqual([
        "brew",
        "thedaily",
      ]);
    } finally {
      fs.renameSync(movedPath, journalPath);
    }
  });
});

describe("ignored senders in read paths", () => {
  const ignoredId = "cccccccc-1111-4111-8111-111111111111";

  beforeEach(() => {
    FeedIdentityInit({
      ignoreList: "billing",
      overrides: {},
      privateUrls: false,
      dataDir,
    });
    EmailItemsBatchSave([
      makeItem({
        messageId: "<ignored@example.com>",
        id: ignoredId,
        senderName: "Billing Team",
        senderEmail: "billing@shop.com",
      }),
      makeItem({ messageId: "<normal@example.com>" }),
    ]);
  });

  it("omits ignored senders from a feed listing", () => {
    const items = EmailItemsListById("billingteam");
    expect(items).toHaveLength(0);
    expect(EmailItemsListById("thedaily")).toHaveLength(1);
  });

  it("does not serve an ignored email by id", () => {
    expect(EmailItemGetById(ignoredId)).toBeUndefined();
    expect(EmailItemGetById("aaaaaaaa-1111-4111-8111-111111111111")).toBeDefined();
  });
});

describe("journal store", () => {
  it("appends saves to emails.jsonl and deduplicates by messageId (last wins)", () => {
    EmailItemsBatchSave([makeItem()]);
    EmailItemsBatchSave([
      makeItem({ id: "cccccccc-1111-4111-8111-111111111111", subject: "Updated" }),
    ]);
    const lines = fs
      .readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(EmailItemsGetExistingIds().size).toBe(1);
    expect(EmailItemGetById("cccccccc-1111-4111-8111-111111111111")).toBeDefined();
    expect(EmailItemGetById("aaaaaaaa-1111-4111-8111-111111111111")).toBeUndefined();
  });

  it("migrates a legacy emails.json array into the journal", () => {
    const legacy = [makeItem({ messageId: "<legacy@example.com>" })];
    fs.writeFileSync(
      path.join(dataDir, "emails.json"),
      JSON.stringify(legacy),
    );
    EmailsDataInit(7, dataDir);
    expect(EmailItemGetById("aaaaaaaa-1111-4111-8111-111111111111")).toBeDefined();
    expect(fs.existsSync(path.join(dataDir, "emails.json"))).toBe(false);
    expect(fs.existsSync(path.join(dataDir, "emails.json.migrated"))).toBe(true);
  });

  it("isolates a partial last line when appending", () => {
    // A previous failed write may leave a record without its trailing newline.
    fs.writeFileSync(journalPath, JSON.stringify(makeItem({ messageId: "<a@example.com>" })));
    EmailsDataInit(7, dataDir);
    EmailItemsBatchSave([
      makeItem({
        id: "bbbbbbbb-1111-4111-8111-111111111111",
        messageId: "<b@example.com>",
      }),
    ]);
    const lines = fs
      .readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(2);
    expect(EmailItemsGetExistingIds()).toEqual(
      new Set(["<a@example.com>", "<b@example.com>"]),
    );
  });

  it("throws when the journal cannot be appended to", () => {
    // A directory at the journal path deterministically makes the append
    // fail (EISDIR) independently of file permissions.
    fs.mkdirSync(journalPath);
    expect(() => EmailItemsBatchSave([makeItem()])).toThrow();
    expect(EmailDataGetUidState()).toEqual({ uid: 0, uidvalidity: 0 });
  });

  it("propagates a journal read error at init instead of serving partial data", () => {
    fs.mkdirSync(journalPath);
    expect(() => EmailsDataInit(7, dataDir)).toThrow();
  });

  it("purges expired items and compacts the journal to one line per message", () => {
    EmailItemsBatchSave([
      makeItem({
        messageId: "<old@example.com>",
        dateReceived: "2020-01-01T00:00:00.000Z",
        dateCreated: "2020-01-01T00:00:00.000Z",
      }),
      makeItem({ messageId: "<new@example.com>" }),
    ]);
    EmailsDataPurgeExpired();
    const lines = fs
      .readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(EmailItemsGetExistingIds()).toEqual(new Set(["<new@example.com>"]));
  });

  it("purges expired items from feeds, permalinks and the sanitized cache", () => {
    const expiredId = "dddddddd-1111-4111-8111-111111111111";
    const expired = makeItem({
      id: expiredId,
      messageId: "<expired-cache@example.com>",
      dateReceived: "2020-01-01T00:00:00.000Z",
      dateCreated: "2020-01-01T00:00:00.000Z",
    });
    EmailItemsBatchSave([expired, makeItem({ messageId: "<new@example.com>" })]);
    SanitizedBodyCacheGet(expired);
    expect(SanitizedBodyCacheStats().entries).toBe(1);

    EmailsDataPurgeExpired();

    expect(EmailItemsListById("thedaily").map((item) => item.messageId)).toEqual([
      "<new@example.com>",
    ]);
    expect(EmailItemGetById(expiredId)).toBeUndefined();
    expect(EmailItemsGetExistingIds()).toEqual(new Set(["<new@example.com>"]));
    expect(SanitizedBodyCacheStats().entries).toBe(0);
  });

  it("compacts duplicate records keeping only the last record per message", () => {
    EmailItemsBatchSave([makeItem({ messageId: "<dup@example.com>" })]);
    EmailItemsBatchSave([
      makeItem({
        id: "eeeeeeee-1111-4111-8111-111111111111",
        messageId: "<dup@example.com>",
        subject: "Second version",
      }),
      makeItem({
        id: "ffffffff-1111-4111-8111-111111111111",
        messageId: "<victim@example.com>",
        dateReceived: "2020-01-01T00:00:00.000Z",
        dateCreated: "2020-01-01T00:00:00.000Z",
      }),
    ]);
    EmailsDataPurgeExpired();
    const lines = fs
      .readFileSync(journalPath, "utf8")
      .split("\n")
      .filter((l) => l.trim());
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).subject).toBe("Second version");
    expect(EmailItemsGetExistingIds()).toEqual(new Set(["<dup@example.com>"]));
  });

  it("leaves the index unchanged when the purge aborts", () => {
    seedLargeJournal();
    const before = fs.readFileSync(journalPath);
    readSyncMock.mockImplementation(() => {
      throw new Error("simulated read failure");
    });
    EmailsDataPurgeExpired();
    expect(fs.readFileSync(journalPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${journalPath}.tmp`)).toBe(false);
    expect(EmailItemsGetExistingIds().has("<expired@example.com>")).toBe(true);
    expect(EmailFeedsListAll()).toHaveLength(1);
  });

  it("aborts the purge without touching the journal on a second-pass read error", () => {
    seedLargeJournal();
    const before = fs.readFileSync(journalPath);
    readSyncMock.mockImplementation((...args: unknown[]) => {
      // The temp file is created before the second walk.
      if (fs.existsSync(`${journalPath}.tmp`)) {
        throw new Error("simulated read failure");
      }
      return (actualFse.readSync as (...a: unknown[]) => number)(...args);
    });
    EmailsDataPurgeExpired();
    expect(fs.readFileSync(journalPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${journalPath}.tmp`)).toBe(false);
  });
});

// A journal larger than one 1 MB read chunk, containing one expired and many
// live records, so the purge rewrites multiple chunks in a single pass.
function seedLargeJournal(): void {
  const items: EmailItem[] = [
    makeItem({
      messageId: "<expired@example.com>",
      dateReceived: "2020-01-01T00:00:00.000Z",
      dateCreated: "2020-01-01T00:00:00.000Z",
    }),
  ];
  const filler = "x".repeat(500);
  for (let i = 0; i < 2400; i++) {
    items.push(
      makeItem({
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        messageId: `<live-${i}@example.com>`,
        body: `<p>${filler}</p>`,
      }),
    );
  }
  EmailItemsBatchSave(items);
  expect(fs.statSync(journalPath).size).toBeGreaterThan(1024 * 1024);
}

describe("UID state", () => {
  it("round-trips the UID and its UIDVALIDITY", () => {
    EmailDataSetUidState(42, 7);
    expect(EmailDataGetUidState()).toEqual({ uid: 42, uidvalidity: 7 });
  });

  it("imports a legacy last-uid.txt marker with an unknown UIDVALIDITY", () => {
    fs.writeFileSync(path.join(dataDir, "last-uid.txt"), "42");
    expect(EmailDataGetUidState()).toEqual({ uid: 42, uidvalidity: 0 });
    // The legacy file is kept so a rollback still resumes correctly.
    expect(fs.existsSync(path.join(dataDir, "last-uid.txt"))).toBe(true);
  });

  it("prefers last-uid.json over the legacy marker", () => {
    fs.writeFileSync(path.join(dataDir, "last-uid.txt"), "42");
    EmailDataSetUidState(10, 3);
    expect(EmailDataGetUidState()).toEqual({ uid: 10, uidvalidity: 3 });
  });

  it("falls back to a full re-scan when the marker is corrupt", () => {
    fs.writeFileSync(path.join(dataDir, "last-uid.json"), "{not json");
    expect(EmailDataGetUidState()).toEqual({ uid: 0, uidvalidity: 0 });
  });
});

describe("EmailsDataGetRecordCount", () => {
  it("counts unique indexed messages", () => {
    expect(EmailsDataGetRecordCount()).toBe(0);

    EmailItemsBatchSave([
      makeItem(),
      makeItem({
        id: "bbbbbbbb-2222-4222-8222-222222222222",
        messageId: "<msg-2@example.com>",
      }),
    ]);
    expect(EmailsDataGetRecordCount()).toBe(2);

    // A re-saved message replaces its record: the count stays stable.
    EmailItemsBatchSave([makeItem()]);
    expect(EmailsDataGetRecordCount()).toBe(2);
  });

  it("drops purged messages from the count", () => {
    EmailItemsBatchSave([
      makeItem({
        messageId: "<old@example.com>",
        dateReceived: "2020-01-01T00:00:00.000Z",
        dateCreated: "2020-01-01T00:00:00.000Z",
      }),
      makeItem({
        id: "cccccccc-3333-4333-8333-333333333333",
        messageId: "<new@example.com>",
      }),
    ]);
    expect(EmailsDataGetRecordCount()).toBe(2);

    EmailsDataPurgeExpired();

    expect(EmailsDataGetRecordCount()).toBe(1);
  });
});

describe("retention and sender-controlled dates", () => {
  it("keeps an email with an old Date header for the full window from ingestion", () => {
    EmailItemsBatchSave([
      makeItem({
        messageId: "<old-header@example.com>",
        dateReceived: "2020-01-01T00:00:00.000Z",
      }),
    ]);

    EmailsDataPurgeExpired();

    expect(EmailItemsGetExistingIds()).toEqual(
      new Set(["<old-header@example.com>"]),
    );
  });

  it("keeps an email created exactly at the cutoff and purges one ms older", () => {
    const fixedNow = Date.parse("2026-06-01T00:00:00.000Z");
    const cutoff = fixedNow - 7 * 24 * 60 * 60 * 1000;
    EmailItemsBatchSave([
      makeItem({
        messageId: "<boundary@example.com>",
        dateCreated: new Date(cutoff).toISOString(),
      }),
      makeItem({
        id: "bbbbbbbb-4444-4444-8444-444444444444",
        messageId: "<older@example.com>",
        dateCreated: new Date(cutoff - 1).toISOString(),
      }),
    ]);

    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(fixedNow);
    try {
      EmailsDataPurgeExpired();
    } finally {
      nowSpy.mockRestore();
    }

    expect(EmailItemsGetExistingIds()).toEqual(
      new Set(["<boundary@example.com>"]),
    );
  });

  it("treats a record without a parsable ingestion date as expired", () => {
    EmailItemsBatchSave([
      makeItem({ messageId: "<no-created@example.com>", dateCreated: "not-a-date" }),
      makeItem({
        id: "cccccccc-5555-4555-8555-555555555555",
        messageId: "<live@example.com>",
      }),
    ]);

    EmailsDataPurgeExpired();

    expect(EmailItemsGetExistingIds()).toEqual(new Set(["<live@example.com>"]));
  });

  it("clamps a future Date header for ordering, latestDate and Last-Modified", () => {
    const now = Date.now();
    const future = new Date(now + 10 * 24 * 60 * 60 * 1000).toISOString();
    const futureItem = makeItem({
      id: "dddddddd-6666-4666-8666-666666666666",
      messageId: "<future@example.com>",
      dateReceived: future,
      dateCreated: new Date(now - 60 * 60 * 1000).toISOString(),
    });
    const normalItem = makeItem({
      id: "eeeeeeee-7777-4777-8777-777777777777",
      messageId: "<normal@example.com>",
      dateReceived: new Date(now - 30 * 60 * 1000).toISOString(),
      dateCreated: new Date(now).toISOString(),
    });
    EmailItemsBatchSave([futureItem, normalItem]);

    // The newer-ingested item sorts first even though the other claims a
    // future date.
    const items = EmailItemsListById("thedaily");
    expect(items.map((item) => item.messageId)).toEqual([
      "<normal@example.com>",
      "<future@example.com>",
    ]);

    const feed = EmailFeedsListAll()[0];
    expect(feed.latestDate).toBe(normalItem.dateReceived);
    expect(Date.parse(feed.latestDate)).toBeLessThanOrEqual(Date.now());
    expect(EmailsDataGetFeedLastModified("thedaily")).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(EmailsDataGetLastModified()).toBeLessThanOrEqual(Date.now());

    // The effective date is the Date header clamped to the ingestion time;
    // the stored journal value keeps the sender's header for provenance.
    expect(EmailItemGetEffectiveDateReceived(futureItem)).toBe(
      new Date(now - 60 * 60 * 1000).toISOString(),
    );
    expect(items[1].dateReceived).toBe(future);
  });
});

describe("feed ids for real sender names", () => {
  it("lists two non-Latin senders as two distinct reachable tokenized feeds", () => {
    EmailItemsBatchSave([
      makeItem({
        id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        messageId: "<cn@example.com>",
        senderName: "中文日报",
        senderEmail: "cn@example.com",
      }),
      makeItem({
        id: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        messageId: "<ru@example.com>",
        senderName: "Новости",
        senderEmail: "ru@example.com",
      }),
    ]);

    const feeds = EmailFeedsListAll();
    expect(feeds).toHaveLength(2);
    for (const feed of feeds) {
      expect(feed.feedId).toMatch(/^sender-[0-9a-f]{8}$/);
      expect(feed.feedId).not.toBe("");
    }
    expect(new Set(feeds.map((feed) => feed.feedId)).size).toBe(2);

    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: true,
      dataDir,
    });
    FeedIdentityEnsureTokens(feeds.map((feed) => feed.feedId));
    for (const feed of feeds) {
      const urlId = FeedIdentityGetFeedUrlId(feed.feedId);
      expect(urlId.startsWith(".")).toBe(false);
      expect(FeedIdentityResolveFeedUrlId(urlId)).toEqual({
        feedId: feed.feedId,
        valid: true,
      });
      expect(EmailItemsListById(feed.feedId)).toHaveLength(1);
    }
  });

  it("warns once when distinct senders normalize to the same feed id", () => {
    EmailItemsBatchSave([
      makeItem({
        id: "33333333-cccc-4ccc-8ccc-cccccccccccc",
        messageId: "<slash@example.com>",
        senderName: "A/B",
        senderEmail: "a@example.com",
      }),
      makeItem({
        id: "44444444-dddd-4ddd-8ddd-dddddddddddd",
        messageId: "<ab@example.com>",
        senderName: "AB",
        senderEmail: "b@example.com",
      }),
    ]);

    const feeds = EmailFeedsListAll();
    expect(feeds).toHaveLength(1);
    expect(feeds[0].feedId).toBe("ab");
    expect(feeds[0].itemCount).toBe(2);

    const collisionWarnings = () =>
      mockLogger.warn.mock.calls.filter((call) =>
        String(call[0]).includes("shared by"),
      );
    expect(collisionWarnings()).toHaveLength(1);
    const message = String(collisionWarnings()[0][0]);
    expect(message).toContain('"ab"');
    expect(message).toContain("A/B <a@example.com>");
    expect(message).toContain("AB <b@example.com>");

    // An unchanged rebuild does not repeat the warning.
    FeedIdentityInit({
      ignoreList: "",
      overrides: {},
      privateUrls: false,
      dataDir,
    });
    expect(EmailFeedsListAll()).toHaveLength(1);
    expect(collisionWarnings()).toHaveLength(1);
  });
});
