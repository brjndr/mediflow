import { addDays } from 'date-fns';
import { formatInTimeZone, fromZonedTime } from 'date-fns-tz';

/**
 * Helpers for the gap between how time is stored (UTC ISO strings) and how a hospital thinks
 * about it ("today", "9:30 on the 14th") in its own timezone. Use them for arithmetic and for
 * request parameters. For display, use the formatters.
 */

const DAY = 'yyyy-MM-dd';
const TIME = 'HH:mm';

/** A calendar day, `2026-10-14`. */
export type DayString = string;

/** The current calendar day at the hospital, which can differ from the browser's and from UTC. */
export function todayIn(timezone: string, now: Date = new Date()): DayString {
  return formatInTimeZone(now, timezone, DAY);
}

/** The day after, by the calendar. Uses UTC noon so daylight-saving shifts cannot skip a day. */
export function nextDay(day: DayString): DayString {
  return formatInTimeZone(addDays(new Date(`${day}T12:00:00Z`), 1), 'UTC', DAY);
}

/**
 * The UTC instants that bound one hospital day, for range queries such as "appointments today".
 * `end` is exclusive: it is the start of the next day. A day is not always 24 hours long.
 */
export function dayBoundsUtc(day: DayString, timezone: string): { start: string; end: string } {
  return {
    start: fromZonedTime(`${day}T00:00:00`, timezone).toISOString(),
    end: fromZonedTime(`${nextDay(day)}T00:00:00`, timezone).toISOString(),
  };
}

/** A date and a 24-hour time as entered at the hospital, as the UTC ISO string to store. */
export function zonedToUtc(day: DayString, time: string, timezone: string): string {
  return fromZonedTime(`${day}T${time}:00`, timezone).toISOString();
}

/** A stored UTC instant as the hospital's date and 24-hour time, to prefill form fields. */
export function utcToZoned(iso: string, timezone: string): { day: DayString; time: string } {
  const instant = new Date(iso);
  return {
    day: formatInTimeZone(instant, timezone, DAY),
    time: formatInTimeZone(instant, timezone, TIME),
  };
}
