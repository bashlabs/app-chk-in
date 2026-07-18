/**
 * Date-range maths for the attendance report.
 *
 * Everything is a `YYYY-MM-DD` string, and every Date is anchored at noon UTC
 * so a timezone or DST shift can never roll a date onto the day either side.
 */

export type PeriodMode = 'day' | 'week' | 'month';

export type Range = { start: string; end: string };

const NOON = 'T12:00:00Z';

const toDate = (s: string) => new Date(`${s}${NOON}`);
const toStr = (d: Date) => d.toISOString().slice(0, 10);

export function addDays(date: string, n: number): string {
  const d = toDate(date);
  d.setUTCDate(d.getUTCDate() + n);
  return toStr(d);
}

/** Church weeks run Sunday → Saturday. */
export function startOfWeek(date: string): string {
  return addDays(date, -toDate(date).getUTCDay());
}

export function startOfMonth(date: string): string {
  return `${date.slice(0, 8)}01`;
}

export function endOfMonth(date: string): string {
  const d = toDate(startOfMonth(date));
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0); // day 0 of next month == last day of this one
  return toStr(d);
}

export function rangeFor(mode: PeriodMode, anchor: string): Range {
  switch (mode) {
    case 'day':
      return { start: anchor, end: anchor };
    case 'week': {
      const start = startOfWeek(anchor);
      return { start, end: addDays(start, 6) };
    }
    case 'month':
      return { start: startOfMonth(anchor), end: endOfMonth(anchor) };
  }
}

/** Steps the anchor one period back (-1) or forward (+1). */
export function shift(mode: PeriodMode, anchor: string, delta: number): string {
  switch (mode) {
    case 'day':
      return addDays(anchor, delta);
    case 'week':
      return addDays(anchor, 7 * delta);
    case 'month': {
      // Anchor on the 1st first, so 31 Jan + 1 month can't overflow into March.
      const d = toDate(startOfMonth(anchor));
      d.setUTCMonth(d.getUTCMonth() + delta);
      return toStr(d);
    }
  }
}

const fmt = (date: string, opts: Intl.DateTimeFormatOptions, locale?: string) =>
  new Intl.DateTimeFormat(locale, { ...opts, timeZone: 'UTC' }).format(toDate(date));

/** @param locale defaults to the admin's own — pass one only to pin it in tests. */
export function labelFor(mode: PeriodMode, anchor: string, locale?: string): string {
  const { start, end } = rangeFor(mode, anchor);

  if (mode === 'day') {
    return fmt(start, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }, locale);
  }

  if (mode === 'month') {
    return fmt(start, { month: 'long', year: 'numeric' }, locale);
  }

  // A week can straddle a month or a year. formatRange collapses whatever the
  // two ends share, in whatever order the locale wants — "12–18 Jul 2026" for
  // en-GB, "Jul 12 – 18, 2026" for en-US. Doing this by hand gets it wrong.
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).formatRange(toDate(start), toDate(end));
}

/** Today, as a local YYYY-MM-DD. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Today if it's Sunday, otherwise the Sunday just gone. */
export function mostRecentSunday(): string {
  return startOfWeek(today());
}
