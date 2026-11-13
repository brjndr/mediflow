import { nextDay, zonedToUtc, type DayString } from '@/shared/utils';

/**
 * The ward's shifts (#160). Like the medication times (`mar-schedule.ts`) they are one fixed
 * table in the hospital's timezone, the same for every device, until they become a hospital
 * setting. A "nursing day" starts with the morning shift, so the night shift belongs to the day
 * it begins on and ends at 06:00 the next morning.
 */
export const SHIFTS = [
  { id: 'morning', start: '06:00', end: '14:00' },
  { id: 'evening', start: '14:00', end: '22:00' },
  { id: 'night', start: '22:00', end: '06:00' },
] as const;
export type ShiftId = (typeof SHIFTS)[number]['id'];

export interface ShiftWindow {
  id: ShiftId;
  /** An ISO instant, included. */
  from: string;
  /** An ISO instant, excluded. */
  to: string;
}

/** The three windows of a nursing day, in order; together they cover 06:00 to 06:00. */
export function shiftWindows(day: DayString, timezone: string): ShiftWindow[] {
  const following = nextDay(day);
  return SHIFTS.map((shift) => ({
    id: shift.id,
    from: zonedToUtc(day, shift.start, timezone),
    to: zonedToUtc(shift.end === '06:00' ? following : day, shift.end, timezone),
  }));
}

/** The shift an instant falls in, by the hospital's clock. */
export function shiftOf(instant: string, timezone: string): ShiftId {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: timezone })
      .formatToParts(new Date(instant))
      .find((part) => part.type === 'hour')?.value ?? '0',
  );
  if (hour >= 6 && hour < 14) return 'morning';
  if (hour >= 14 && hour < 22) return 'evening';
  return 'night';
}
