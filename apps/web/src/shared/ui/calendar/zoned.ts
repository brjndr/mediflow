import { toZonedTime } from 'date-fns-tz';
import type { DayString } from '@/shared/utils/timezone';

/**
 * The calendar library works in the browser's own timezone, and the hospital's may differ. So it
 * is given "wall" dates: a Date whose local fields (day, hour, minute) are the hospital's clock at
 * that instant. It never sees the real instant, and the browser's timezone changes nothing shown.
 * The one gap: a hospital time that does not exist in the browser's timezone (the hour skipped
 * when the browser's clocks go forward) is drawn an hour later.
 */

export type CalendarView = 'day' | 'week';

/** An instant (UTC ISO string or Date) as the hospital's wall clock. */
export function toWall(instant: string | Date, timezone: string): Date {
  return toZonedTime(instant, timezone);
}

/** A calendar day as a wall date at noon, which no daylight-saving change can move off the day. */
export function dayToWall(day: DayString): Date {
  const [year, month, date] = day.split('-').map(Number);
  return new Date(year ?? 1970, (month ?? 1) - 1, date ?? 1, 12);
}

/** The calendar day of a wall date. */
export function wallToDay(wall: Date): DayString {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${wall.getFullYear()}-${pad(wall.getMonth() + 1)}-${pad(wall.getDate())}`;
}

/** The calendar day this many days from another, counted at UTC noon so no day is skipped. */
export function addDays(day: DayString, by: number): DayString {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + by);
  return date.toISOString().slice(0, 10);
}

/**
 * Regions whose week starts on Sunday or Saturday, from CLDR's `firstDay` (every other region
 * starts on Monday). A table rather than `Intl.Locale` week info, which Firefox does not have:
 * two people at one hospital must see the same week, and ask the server for the same days,
 * whichever browser each uses.
 */
const SUNDAY_FIRST = new Set(
  'AG AS BD BR BS BT BW BZ CA CN CO DM DO ET GT GU HK HN ID IL IN JM JP KE KH KR LA MH MM MO MT MX MZ NI NP PA PE PH PK PR PT PY SA SG SV TH TT TW UM US VE VI WS YE ZA ZW'.split(
    ' ',
  ),
);
const SATURDAY_FIRST = new Set('AE AF BH DJ DZ EG IQ IR JO KW LY OM QA SD SY'.split(' '));

/**
 * The first day of the week where the hospital is, 0 for Sunday to 6 for Saturday, from its
 * locale's region, or the region most likely for its language (`en-IN`: Sunday, `en-GB`:
 * Monday, `en`: the US, Sunday). Monday, as ISO 8601, for a locale that cannot be read.
 */
export function weekStartFor(locale: string): number {
  let region: string | undefined;
  try {
    region = new Intl.Locale(locale).maximize().region;
  } catch {
    return 1;
  }
  if (region === undefined) return 1;
  if (SUNDAY_FIRST.has(region)) return 0;
  if (SATURDAY_FIRST.has(region)) return 6;
  return 1;
}

/** The first and the last calendar day a view shows, both included. */
export function visibleDays(
  view: CalendarView,
  day: DayString,
  weekStart: number,
): { from: DayString; to: DayString } {
  if (view === 'day') return { from: day, to: day };
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  const from = addDays(day, -((weekday - weekStart + 7) % 7));
  return { from, to: addDays(from, 6) };
}
