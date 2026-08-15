/**
 * Minimal 5-field cron parser and matcher (no dependency).
 *
 * Fields: minute hour day-of-month month day-of-week
 * Supported syntax per field: star, star-slash-n, a-b, a-b-slash-n,
 * comma lists, single value. day-of-week: 0-7 (0 and 7 both mean Sunday).
 * Standard cron day semantics: when BOTH day-of-month and day-of-week are
 * restricted (not `*`), a date matches if EITHER field matches.
 */

export interface CronSchedule {
  raw: string;
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
}

const MINUTE = { min: 0, max: 59 };
const HOUR = { min: 0, max: 23 };
const DOM = { min: 1, max: 31 };
const MONTH = { min: 1, max: 12 };
const DOW = { min: 0, max: 7 };

function parseField(field: string, range: { min: number; max: number }): Set<number> | null {
  const values = new Set<number>();
  if (field === "*") {
    for (let i = range.min; i <= range.max; i++) values.add(i);
    return values;
  }
  for (const part of field.split(",")) {
    const stepMatch = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!stepMatch) return null;
    const [, , singleStr, endStr, stepStr] = stepMatch;
    let start: number;
    let end: number;
    if (stepMatch[1] === "*") {
      start = range.min;
      end = range.max;
    } else {
      start = Number(singleStr);
      end = endStr ? Number(endStr) : start;
    }
    const step = stepStr ? Number(stepStr) : 1;
    if (step < 1) return null;
    for (let i = start; i <= end; i += step) {
      if (i < range.min || i > range.max) return null;
      values.add(i);
    }
  }
  return values.size > 0 ? values : null;
}

export function parseCron(expr: string): CronSchedule | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minutes = parseField(parts[0], MINUTE);
  const hours = parseField(parts[1], HOUR);
  const daysOfMonth = parseField(parts[2], DOM);
  const months = parseField(parts[3], MONTH);
  const daysOfWeekRaw = parseField(parts[4], DOW);
  if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeekRaw) return null;
  // 0 and 7 both mean Sunday.
  const daysOfWeek = new Set<number>();
  for (const d of daysOfWeekRaw) daysOfWeek.add(d === 7 ? 0 : d);
  return { raw: expr.trim(), minutes, hours, daysOfMonth, months, daysOfWeek };
}

function dateMatches(sched: CronSchedule, d: Date): boolean {
  const dom = sched.daysOfMonth;
  const dow = sched.daysOfWeek;
  const domRestricted = dom.size < 31;
  const dowRestricted = dow.size < 7;
  let dayOk: boolean;
  if (domRestricted && dowRestricted) {
    dayOk = dom.has(d.getDate()) || dow.has(d.getDay());
  } else if (domRestricted) {
    dayOk = dom.has(d.getDate());
  } else if (dowRestricted) {
    dayOk = dow.has(d.getDay());
  } else {
    dayOk = true;
  }
  return (
    dayOk &&
    sched.months.has(d.getMonth() + 1) &&
    sched.hours.has(d.getHours()) &&
    sched.minutes.has(d.getMinutes())
  );
}

/**
 * Next time strictly after `from` matching the schedule. Scans minute by
 * minute up to ~2 years out; returns null if nothing matches (invalid or
 * far-future-only expressions are treated as no-next-run).
 */
export function nextRun(sched: CronSchedule, from: Date): Date | null {
  const d = new Date(from.getTime() + 60_000);
  d.setSeconds(0, 0);
  const limit = from.getTime() + 2 * 366 * 24 * 60 * 60 * 1000;
  while (d.getTime() <= limit) {
    if (dateMatches(sched, d)) return d;
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

/** Human-friendly summary of the next run, e.g. "in 3h 12m". */
export function describeNextRun(next: Date | null, now: Date = new Date()): string {
  if (!next) return "—";
  const diffMs = next.getTime() - now.getTime();
  if (diffMs <= 0) return "now";
  const totalMin = Math.round(diffMs / 60_000);
  if (totalMin < 60) return `in ${totalMin}m`;
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h < 24) return m ? `in ${h}h ${m}m` : `in ${h}h`;
  const days = Math.floor(h / 24);
  const remH = h % 24;
  return remH ? `in ${days}d ${remH}h` : `in ${days}d`;
}
