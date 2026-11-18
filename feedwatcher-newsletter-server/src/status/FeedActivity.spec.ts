import {
  FEED_QUIET_AFTER_DAYS,
  FeedActivityDaysSince,
  FeedActivityIsQuiet,
} from "./FeedActivity";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-11-18T12:00:00.000Z");

describe("FeedActivityDaysSince", () => {
  it("counts whole days since the latest email", () => {
    expect(
      FeedActivityDaysSince(new Date(NOW - 6 * DAY).toISOString(), NOW),
    ).toBe(6);
    expect(
      FeedActivityDaysSince(new Date(NOW - 7 * DAY).toISOString(), NOW),
    ).toBe(7);
    expect(
      FeedActivityDaysSince(new Date(NOW - 30 * DAY).toISOString(), NOW),
    ).toBe(30);
  });

  it("returns null for missing or invalid dates", () => {
    expect(FeedActivityDaysSince(null, NOW)).toBeNull();
    expect(FeedActivityDaysSince(undefined, NOW)).toBeNull();
    expect(FeedActivityDaysSince("", NOW)).toBeNull();
    expect(FeedActivityDaysSince("not-a-date", NOW)).toBeNull();
  });

  it("treats a future date as zero days, not as quiet", () => {
    expect(
      FeedActivityDaysSince(new Date(NOW + 2 * DAY).toISOString(), NOW),
    ).toBe(0);
  });
});

describe("FeedActivityIsQuiet", () => {
  it("marks a feed quiet from the configured threshold", () => {
    expect(FEED_QUIET_AFTER_DAYS).toBe(7);
    expect(
      FeedActivityIsQuiet(new Date(NOW - 6 * DAY).toISOString(), NOW),
    ).toBe(false);
    expect(
      FeedActivityIsQuiet(new Date(NOW - 7 * DAY).toISOString(), NOW),
    ).toBe(true);
  });

  it("never marks an unknown or future date quiet", () => {
    expect(FeedActivityIsQuiet(null, NOW)).toBe(false);
    expect(FeedActivityIsQuiet("not-a-date", NOW)).toBe(false);
    expect(
      FeedActivityIsQuiet(new Date(NOW + DAY).toISOString(), NOW),
    ).toBe(false);
  });
});
