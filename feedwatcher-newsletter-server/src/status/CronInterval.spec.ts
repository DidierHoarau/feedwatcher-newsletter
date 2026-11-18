import {
  CRON_FALLBACK_INTERVAL_MS,
  CronIntervalMs,
} from "./CronInterval";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// Local-time constructions keep the expectations independent of the test
// machine timezone; day-scale assertions are ranges to stay DST-safe.
function local(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): number {
  return new Date(year, month - 1, day, hour, minute).getTime();
}

describe("CronIntervalMs", () => {
  it("estimates hourly and sub-hourly schedules", () => {
    const now = local(2026, 11, 18, 10, 23);
    expect(CronIntervalMs("0 * * * *", now)).toBe(HOUR);
    expect(CronIntervalMs("*/15 * * * *", now)).toBe(15 * MINUTE);
    expect(CronIntervalMs("* * * * *", now)).toBe(MINUTE);
  });

  it("estimates a multi-hour schedule", () => {
    expect(CronIntervalMs("0 */6 * * *", local(2026, 11, 18, 10, 23))).toBe(
      6 * HOUR,
    );
  });

  it("estimates a fixed-hour daily schedule", () => {
    const gap = CronIntervalMs("0 8 * * *", local(2026, 11, 18, 10, 23));
    expect(gap).toBeGreaterThanOrEqual(23 * HOUR);
    expect(gap).toBeLessThanOrEqual(25 * HOUR);
  });

  it("estimates a weekly day-of-week schedule and normalizes Sunday 7 to 0", () => {
    const now = local(2026, 11, 18, 10, 23); // Wednesday
    const monday = CronIntervalMs("0 8 * * 1", now);
    expect(monday).toBeGreaterThanOrEqual(6.9 * DAY);
    expect(monday).toBeLessThanOrEqual(7.1 * DAY);
    expect(CronIntervalMs("0 8 * * 7", now)).toBe(
      CronIntervalMs("0 8 * * 0", now),
    );
  });

  it("estimates a monthly day-of-month schedule", () => {
    const gap = CronIntervalMs("0 0 1 * *", local(2026, 11, 18, 10, 23));
    expect(gap).toBeGreaterThanOrEqual(28 * DAY);
    expect(gap).toBeLessThanOrEqual(32 * DAY);
  });

  it("accepts comma lists and ranges", () => {
    expect(CronIntervalMs("0,30 8-18 * * *", local(2026, 11, 18, 10, 23))).toBe(
      30 * MINUTE,
    );
  });

  it("falls back to one hour for invalid or unsupported expressions", () => {
    for (const expression of [
      "",
      "   ",
      "not a cron",
      "0 0 8 * * *", // 6-field (seconds) cron
      "60 * * * *",
      "0 24 * * *",
      "*/0 * * * *",
      "0 0 32 * *",
      "0 0 * 13 *",
      "0 0 * * 8",
      "1-2-3 * * * *",
      "*/x * * * *",
      "5-1 * * * *",
      "0, 8 * * *",
    ]) {
      expect(CronIntervalMs(expression, local(2026, 11, 18, 10, 23))).toBe(
        CRON_FALLBACK_INTERVAL_MS,
      );
    }
  });

  it("falls back for an impossible date instead of searching forever", () => {
    expect(CronIntervalMs("0 0 31 2 *", local(2026, 11, 18, 10, 23))).toBe(
      CRON_FALLBACK_INTERVAL_MS,
    );
  });

  it("is stable across repeated calls for the same expression", () => {
    const now = local(2026, 11, 18, 10, 23);
    expect(CronIntervalMs("30 9 * * *", now)).toBe(
      CronIntervalMs("30 9 * * *", now),
    );
  });
});
