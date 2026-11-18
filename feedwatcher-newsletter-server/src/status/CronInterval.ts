// Estimated interval between two runs of a 5-field cron expression. Pure and
// dependency-free: the scheduler owns the real schedule (node-schedule), this
// helper only sizes the "stale fetch" threshold shown in the human UI.
export const CRON_FALLBACK_INTERVAL_MS = 60 * 60 * 1000;

const MINUTE_MS = 60 * 1000;
const MAX_SEARCH_DAYS = 366 * 4 + 1;

interface CronSpec {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[];
  months: number[];
  daysOfWeek: number[];
  dayOfMonthRestricted: boolean;
  dayOfWeekRestricted: boolean;
}

const specCache = new Map<string, CronSpec | null>();

function parseNumber(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  if (parsed < min || parsed > max) {
    return null;
  }
  return parsed;
}

// One list item: `*`, `*/n`, `a`, `a-b`, `a-b/n`. Returns the accepted values
// or null when the item is invalid.
function parseFieldItem(
  item: string,
  min: number,
  max: number,
): number[] | null {
  if (item === "*") {
    const all: number[] = [];
    for (let value = min; value <= max; value += 1) {
      all.push(value);
    }
    return all;
  }
  if (item.startsWith("*/")) {
    const step = parseNumber(item.slice(2), 1, max);
    if (step === null) return null;
    const values: number[] = [];
    for (let value = min; value <= max; value += step) {
      values.push(value);
    }
    return values;
  }
  if (item.includes("/")) {
    const parts = item.split("/");
    if (parts.length !== 2 || !parts[0].includes("-")) return null;
    const [range, stepText] = parts;
    const step = parseNumber(stepText, 1, max);
    if (step === null) return null;
    const rangeParts = range.split("-");
    if (rangeParts.length !== 2) return null;
    const [fromText, toText] = rangeParts;
    const from = parseNumber(fromText, min, max);
    const to = parseNumber(toText, min, max);
    if (from === null || to === null || from > to) return null;
    const values: number[] = [];
    for (let value = from; value <= to; value += step) {
      values.push(value);
    }
    return values;
  }
  if (item.includes("-")) {
    const parts = item.split("-");
    if (parts.length !== 2) return null;
    const [fromText, toText] = parts;
    const from = parseNumber(fromText, min, max);
    const to = parseNumber(toText, min, max);
    if (from === null || to === null || from > to) return null;
    const values: number[] = [];
    for (let value = from; value <= to; value += 1) {
      values.push(value);
    }
    return values;
  }
  const single = parseNumber(item, min, max);
  return single === null ? null : [single];
}

function parseField(
  field: string,
  min: number,
  max: number,
): { values: number[]; restricted: boolean } | null {
  const values = new Set<number>();
  let restricted = false;
  for (const item of field.split(",")) {
    if (item === "") return null;
    if (item !== "*") {
      restricted = true;
    }
    const parsed = parseFieldItem(item, min, max);
    if (parsed === null) return null;
    for (const value of parsed) {
      values.add(value);
    }
  }
  if (values.size === 0) return null;
  return { values: [...values].sort((a, b) => a - b), restricted };
}

// Strictly 5 fields: an extended (6-field, seconds) expression cannot be
// estimated safely, so it falls back instead of guessing.
function parseCronExpression(expression: string): CronSpec | null {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    return null;
  }
  const minute = parseField(fields[0], 0, 59);
  const hour = parseField(fields[1], 0, 23);
  const dayOfMonth = parseField(fields[2], 1, 31);
  const month = parseField(fields[3], 1, 12);
  // Day-of-week accepts 7 as Sunday and normalizes it to 0.
  const dayOfWeek = parseField(fields[4], 0, 7);
  if (!minute || !hour || !dayOfMonth || !month || !dayOfWeek) {
    return null;
  }
  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values.filter((value) => value <= 31),
    months: month.values,
    daysOfWeek: [...new Set(dayOfWeek.values.map((value) => value % 7))].sort(
      (a, b) => a - b,
    ),
    dayOfMonthRestricted: dayOfMonth.restricted,
    dayOfWeekRestricted: dayOfWeek.restricted,
  };
}

function getCronSpec(expression: string): CronSpec | null {
  if (specCache.has(expression)) {
    return specCache.get(expression) ?? null;
  }
  const spec = parseCronExpression(expression);
  specCache.set(expression, spec);
  return spec;
}

// Vixie-cron day semantics: when both day fields are restricted, either may
// match; when only one is restricted, it must match.
function dayMatches(spec: CronSpec, date: Date): boolean {
  const domMatches = spec.daysOfMonth.includes(date.getDate());
  const dowMatches = spec.daysOfWeek.includes(date.getDay());
  if (spec.dayOfMonthRestricted && spec.dayOfWeekRestricted) {
    return domMatches || dowMatches;
  }
  return domMatches && dowMatches;
}

function nextOccurrence(spec: CronSpec, fromMs: number): Date | undefined {
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const cursor = new Date(
    start.getFullYear(),
    start.getMonth(),
    start.getDate(),
  );
  for (let day = 0; day < MAX_SEARCH_DAYS; day += 1) {
    if (
      spec.months.includes(cursor.getMonth() + 1) &&
      dayMatches(spec, cursor)
    ) {
      for (const hour of spec.hours) {
        for (const minute of spec.minutes) {
          const candidate = new Date(
            cursor.getFullYear(),
            cursor.getMonth(),
            cursor.getDate(),
            hour,
            minute,
          );
          if (candidate.getTime() >= start.getTime()) {
            return candidate;
          }
        }
      }
    }
    cursor.setDate(cursor.getDate() + 1);
  }
  return undefined;
}

export function CronIntervalMs(
  expression: string,
  nowMs: number = Date.now(),
): number {
  if (typeof expression !== "string" || expression.trim() === "") {
    return CRON_FALLBACK_INTERVAL_MS;
  }
  const spec = getCronSpec(expression);
  if (!spec) {
    return CRON_FALLBACK_INTERVAL_MS;
  }
  const first = nextOccurrence(spec, nowMs);
  if (!first) {
    return CRON_FALLBACK_INTERVAL_MS;
  }
  const second = nextOccurrence(spec, first.getTime());
  if (!second) {
    return CRON_FALLBACK_INTERVAL_MS;
  }
  const gap = second.getTime() - first.getTime();
  if (!Number.isFinite(gap) || gap < MINUTE_MS) {
    return CRON_FALLBACK_INTERVAL_MS;
  }
  return gap;
}
