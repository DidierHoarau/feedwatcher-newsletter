// Per-feed activity derived from the latest retained email. Pure module so the
// catalogue can mark a quiet sender without importing app or OTel code.
export const FEED_QUIET_AFTER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export function FeedActivityDaysSince(
  latestDate: string | null | undefined,
  nowMs: number = Date.now(),
): number | null {
  if (!latestDate) {
    return null;
  }
  const latestMs = Date.parse(latestDate);
  if (!Number.isFinite(latestMs)) {
    return null;
  }
  // A future date (sender clock drift, clock skew) is not "quiet".
  if (latestMs >= nowMs) {
    return 0;
  }
  return Math.floor((nowMs - latestMs) / DAY_MS);
}

export function FeedActivityIsQuiet(
  latestDate: string | null | undefined,
  nowMs: number = Date.now(),
): boolean {
  const days = FeedActivityDaysSince(latestDate, nowMs);
  return days !== null && days >= FEED_QUIET_AFTER_DAYS;
}
