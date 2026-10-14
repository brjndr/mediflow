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
