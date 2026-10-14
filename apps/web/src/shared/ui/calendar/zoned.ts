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

interface WeekInfo {
  firstDay: number;
}
type LocaleWithWeek = Intl.Locale & { getWeekInfo?: () => WeekInfo; weekInfo?: WeekInfo };

/**
 * The first day of the week where the hospital is, 0 for Sunday to 6 for Saturday. From the
 * locale's region where the browser knows it (not Firefox yet), Monday otherwise, as ISO 8601.
 */
export function weekStartFor(locale: string): number {
  try {
    const info = new Intl.Locale(locale) as LocaleWithWeek;
    const firstDay = (info.getWeekInfo?.() ?? info.weekInfo)?.firstDay;
    // Intl counts 1 for Monday to 7 for Sunday.
    if (firstDay !== undefined) return firstDay % 7;
  } catch {
    // An unknown locale: fall through to the default.
  }
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
