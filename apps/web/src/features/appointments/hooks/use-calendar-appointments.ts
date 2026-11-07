import { useQuery } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import type { DayString } from '@/shared/utils/timezone';
import { fetchAppointments } from '../api';
import type { AppointmentSummary } from '../types';
import { appointmentKeys } from './use-appointments';

/** The largest page the API gives. */
export const CALENDAR_PAGE_SIZE = 100;
/** One doctor's week stays far below this. Past it, the calendar says some are not shown. */
export const CALENDAR_MAX_APPOINTMENTS = 500;

/**
 * The key of a calendar's range: under the hospital's appointments, so a booking's invalidation
 * of `appointmentKeys.all` refreshes it, but not under `lists`, whose entries are the list's
 * pages. An update aimed at the lists never meets data of another shape.
 */
export const calendarKey = (
  tenantId: string,
  range: { from: DayString; to: DayString; doctorId: string },
) => [...appointmentKeys.all(tenantId), 'calendar', range] as const;

/** Live data, as the list: the desk books and changes appointments all day. */
const STALE_TIME_MS = 15_000;

export interface CalendarAppointments {
  items: AppointmentSummary[];
  /** More appointments than `CALENDAR_MAX_APPOINTMENTS` in the range: the rest are not shown. */
  truncated: boolean;
}

/**
 * One doctor's appointments on the days a calendar shows, every status. A calendar draws the
 * whole range at once, so the pages of that range are read one after the other, up to a cap:
 * the range is a day or a week of one doctor, never the hospital's whole book.
 */
export function useCalendarAppointments(
  { from, to, doctorId }: { from: DayString; to: DayString; doctorId: string },
  enabled = true,
) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: calendarKey(tenantId ?? '', { from, to, doctorId }),
    queryFn: async ({ signal }): Promise<CalendarAppointments> => {
      const items: AppointmentSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await fetchAppointments(
          { from, to, doctorId, status: '', cursor, limit: CALENDAR_PAGE_SIZE },
          signal,
        );
        items.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined && items.length < CALENDAR_MAX_APPOINTMENTS);
      return { items, truncated: cursor !== undefined };
    },
    enabled: enabled && tenantId !== undefined && doctorId !== '',
    staleTime: STALE_TIME_MS,
    // The same doctor's previous range stays drawn while the next one loads, marked as loading.
    // Never another doctor's: their appointments would be drawn, and opened, under this name.
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey.at(-1) as { doctorId?: string } | undefined)?.doctorId === doctorId
        ? previous
        : undefined,
  });
}

/** Most doctors drawn side by side: eight columns still leave a column wide enough to read. */
export const MAX_SIDE_BY_SIDE = 8;

/** The key of several doctors' day: the doctors sorted, so the same set is one entry. */
export const doctorsDayKey = (tenantId: string, range: { day: DayString; doctorIds: string[] }) =>
  [
    ...appointmentKeys.all(tenantId),
    'calendar',
    { day: range.day, doctorIds: [...range.doctorIds].sort().join(',') },
  ] as const;

/**
 * Several doctors' appointments on one day, every status, for the calendar's doctors view. The API
 * filters by one doctor, so each doctor's day is asked for on its own, at the same time, each
 * following its cursor; together they stop at the calendar's cap (a later API change may take
 * several doctors in one request). A different set of doctors is a different entry, and its
 * placeholder is never another set's: those appointments would be drawn under the wrong columns.
 */
export function useDoctorsDayAppointments(
  { day, doctorIds }: { day: DayString; doctorIds: string[] },
  enabled = true,
) {
  const tenantId = useTenant()?.id;
  const key = doctorsDayKey(tenantId ?? '', { day, doctorIds });
  return useQuery({
    queryKey: key,
    queryFn: async ({ signal }): Promise<CalendarAppointments> => {
      const items: AppointmentSummary[] = [];
      let truncated = false;
      await Promise.all(
        doctorIds.map(async (doctorId) => {
          let cursor: string | undefined;
          do {
            const page = await fetchAppointments(
              { from: day, to: day, doctorId, status: '', cursor, limit: CALENDAR_PAGE_SIZE },
              signal,
            );
            items.push(...page.items);
            cursor = page.nextCursor ?? undefined;
          } while (cursor !== undefined && items.length < CALENDAR_MAX_APPOINTMENTS);
          if (cursor !== undefined) truncated = true;
        }),
      );
      // Past the cap, say so; and never draw more than the cap.
      if (items.length > CALENDAR_MAX_APPOINTMENTS) truncated = true;
      return { items: items.slice(0, CALENDAR_MAX_APPOINTMENTS), truncated };
    },
    enabled: enabled && tenantId !== undefined && doctorIds.length > 0,
    staleTime: STALE_TIME_MS,
    placeholderData: (previous, previousQuery) =>
      (previousQuery?.queryKey.at(-1) as { doctorIds?: string } | undefined)?.doctorIds ===
      doctorIds.slice().sort().join(',')
        ? previous
        : undefined,
  });
}
