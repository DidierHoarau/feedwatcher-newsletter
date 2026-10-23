import { EmailItem } from "./EmailFetcher";
import {
  SANITIZED_BODY_CACHE_MAX_BYTES,
  SanitizedBodyCacheEvict,
  SanitizedBodyCacheGet,
  SanitizedBodyCacheReset,
  SanitizedBodyCacheStats,
} from "./SanitizedBodyCache";

function makeItem(overrides: Partial<EmailItem> = {}): EmailItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    messageId: "<msg-1@example.com>",
    senderName: "The Daily",
    senderEmail: "news@example.com",
    subject: "Issue",
    body: "<p>Hello <script>alert('xss')</script> world</p>",
    dateReceived: "2026-10-15T08:00:00.000Z",
    dateCreated: "2026-10-15T08:00:00.000Z",
    ...overrides,
  };
}

function bigBody(charCount: number): string {
  return `<p>${"x".repeat(charCount)}</p>`;
}

beforeEach(() => {
  SanitizedBodyCacheReset();
});

describe("SanitizedBodyCacheGet", () => {
  it("sanitizes once and returns the same cached entry afterwards", () => {
    const item = makeItem();
    const first = SanitizedBodyCacheGet(item);
    const second = SanitizedBodyCacheGet(item);
    expect(second).toBe(first);
    expect(first.html).not.toContain("<script>");
    expect(first.summary).toBe("Hello world");
    expect(SanitizedBodyCacheStats()).toEqual({
      entries: 1,
      bytes: (first.html.length + first.summary.length) * 2,
    });
  });

  it("keeps sanitizer configurations as distinct entries", () => {
    const item = makeItem({
      body: '<p>Hi</p><img src="https://tracker.example/p" width="1">',
    });
    const stripped = SanitizedBodyCacheGet(item, true);
    const kept = SanitizedBodyCacheGet(item, false);
    expect(stripped.html).not.toContain("tracker.example");
    expect(kept.html).toContain("tracker.example");
    expect(SanitizedBodyCacheStats().entries).toBe(2);
  });

  it("serves a re-sanitized body for a re-saved message with a new item id", () => {
    const original = SanitizedBodyCacheGet(
      makeItem({ body: "<p>Sensitive</p>" }),
    );
    const resaved = SanitizedBodyCacheGet(
      makeItem({
        id: "22222222-2222-4222-8222-222222222222",
        body: "<p>Corrected</p>",
      }),
    );
    expect(original.summary).toBe("Sensitive");
    expect(resaved.summary).toBe("Corrected");
  });
});

describe("SanitizedBodyCache bounds", () => {
  it("evicts the least recently used entry when over the byte bound", () => {
    // Each entry accounts ~2 * 5.7M chars; three exceed the 32 MiB bound.
    const chars = Math.ceil(SANITIZED_BODY_CACHE_MAX_BYTES / 6);
    const itemA = makeItem({
      id: "aaaaaaaa-1111-4111-8111-111111111111",
      body: bigBody(chars),
    });
    const itemB = makeItem({
      id: "bbbbbbbb-1111-4111-8111-111111111111",
      body: bigBody(chars),
    });
    const itemC = makeItem({
      id: "cccccccc-1111-4111-8111-111111111111",
      body: bigBody(chars),
    });
    const cachedA = SanitizedBodyCacheGet(itemA);
    SanitizedBodyCacheGet(itemB);
    // Touch A: it must survive the next eviction, B is the oldest.
    expect(SanitizedBodyCacheGet(itemA)).toBe(cachedA);
    SanitizedBodyCacheGet(itemC);
    const stats = SanitizedBodyCacheStats();
    expect(stats.entries).toBe(2);
    expect(stats.bytes).toBeLessThanOrEqual(SANITIZED_BODY_CACHE_MAX_BYTES);
    expect(SanitizedBodyCacheGet(itemA)).toBe(cachedA);
  });
});

describe("SanitizedBodyCacheEvict and Reset", () => {
  it("evicts every configuration of the given items", () => {
    const item = makeItem();
    SanitizedBodyCacheGet(item, true);
    SanitizedBodyCacheGet(item, false);
    SanitizedBodyCacheGet(
      makeItem({ id: "33333333-3333-4333-8333-333333333333" }),
    );
    SanitizedBodyCacheEvict([item.id]);
    expect(SanitizedBodyCacheStats().entries).toBe(1);
  });

  it("resets the whole cache", () => {
    SanitizedBodyCacheGet(makeItem());
    SanitizedBodyCacheReset();
    expect(SanitizedBodyCacheStats()).toEqual({ entries: 0, bytes: 0 });
  });
});
