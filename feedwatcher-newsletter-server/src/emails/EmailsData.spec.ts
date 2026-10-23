import * as fs from "fs";
import * as os from "os";
import path from "path";
import * as fse from "fs-extra";
import {
  EmailsDataInit,
  EmailDataGetUidState,
  EmailDataSetUidState,
  EmailFeedsListAll,
  EmailItemGetById,
  EmailItemsBatchSave,
  EmailItemsGetExistingIds,
  EmailsDataPurgeExpired,
} from "./EmailsData";
import { EmailItem } from "./EmailFetcher";
import { FeedIdentityInit } from "../feeds/FeedIdentity";

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

  it("propagates a journal read error instead of returning partial data", () => {
    fs.mkdirSync(journalPath);
    expect(() => EmailItemsGetExistingIds()).toThrow();
    expect(() => EmailFeedsListAll()).toThrow();
  });

  it("purges expired items and compacts the journal to one line per message", () => {
    EmailItemsBatchSave([
      makeItem({ messageId: "<old@example.com>", dateReceived: "2020-01-01T00:00:00.000Z" }),
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

  it("aborts the purge without touching the journal on a first-pass read error", () => {
    seedLargeJournal();
    const before = fs.readFileSync(journalPath);
    readSyncMock.mockImplementation(() => {
      throw new Error("simulated read failure");
    });
    EmailsDataPurgeExpired();
    expect(fs.readFileSync(journalPath).equals(before)).toBe(true);
    expect(fs.existsSync(`${journalPath}.tmp`)).toBe(false);
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
// live records, so the purge performs two multi-chunk passes.
function seedLargeJournal(): void {
  const items: EmailItem[] = [
    makeItem({
      messageId: "<expired@example.com>",
      dateReceived: "2020-01-01T00:00:00.000Z",
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
