import * as fs from "fs";
import * as os from "os";
import path from "path";
import { EmailsDataInit, EmailFeedsListAll, EmailItemGetById, EmailItemsBatchSave } from "./EmailsData";
import { EmailItem } from "./EmailFetcher";
import { FeedIdentityInit } from "../feeds/FeedIdentity";

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  const item: EmailItem = {
    id: "aaaaaaaa-1111-4111-8111-111111111111",
    messageId: "<msg-1@example.com>",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    subject: "Issue",
    body: "<p>hi</p>",
    dateReceived: "2026-10-15T08:00:00.000Z",
    dateCreated: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
  return item;
}

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "emailsdata-"));
  EmailsDataInit(7, dataDir);
  FeedIdentityInit({
    ignoreList: "",
    overrides: {},
    privateUrls: false,
    dataDir,
  });
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
