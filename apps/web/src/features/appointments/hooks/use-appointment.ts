import {
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from '@tanstack/react-query';
import { useRef } from 'react';
import { sessionKey, useSession, type Session } from '@/app/session';
import { useTenant } from '@/tenancy';
import { changeAppointment, fetchAppointment, type AppointmentChange } from '../api';
import type { Appointment, AppointmentPage, AppointmentStatus } from '../types';
import { appointmentKeys } from './use-appointments';

/** Live data: the desk and the doctors change appointments all day. */
const STALE_TIME_MS = 15_000;

/** One appointment, with the reason for the visit. */
export function useAppointment(id: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: appointmentKeys.detail(tenantId ?? '', id),
    queryFn: ({ signal }) => fetchAppointment(id, signal),
    enabled: tenantId !== undefined && id !== '',
    staleTime: STALE_TIME_MS,
  });
}

/** The status a change leads to, shown before the server answers. Not for a move. */
const OPTIMISTIC: Partial<Record<AppointmentChange['kind'], AppointmentStatus>> = {
  cancel: 'cancelled',
  complete: 'completed',
  no_show: 'no_show',
};

type Pages = InfiniteData<AppointmentPage>;

/**
 * Changes one appointment. A change of status shows at once, on the appointment and in the list
 * pages held in memory, and goes back if the server refuses it. A move is not shown before the
 * server answers: it can be refused for a time taken meanwhile, and the form stays open for that.
 * Whatever the answer, everything about appointments is asked for again, which also refreshes the
 * calendar and the free times.
 *
 * Every request carries an idempotency key, one per body: a double click or a retry returns the
 * first answer.
 */
export function useChangeAppointment(id: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id ?? '';
  const userId = useSession()?.user.id;
  const attempt = useRef<{ body: string; key: string }>(undefined);
  const detailKey = appointmentKeys.detail(tenantId, id);

  // The answer can arrive after the person has signed out or moved to another hospital, when
  // everything they had loaded has been dropped. Nothing is written then: it would put a
  // patient's appointment back in memory for whoever signs in next.
  const sameSession = () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return (
      userId !== undefined && session?.user.id === userId && session.activeTenant?.id === tenantId
    );
  };

  const mutation = useMutation({
    // The variables hold the change. They go as soon as the request is over.
    gcTime: 0,
    mutationFn: ({ change, key }: { change: AppointmentChange; key: string }) =>
      changeAppointment(id, change, key),
    onMutate: async ({ change }) => {
      const status = OPTIMISTIC[change.kind];
      if (!status) return undefined;
      // A read in flight would put the old status back over the change.
      await queryClient.cancelQueries({ queryKey: detailKey, exact: true });
      await queryClient.cancelQueries({ queryKey: appointmentKeys.lists(tenantId) });
      const previousRecord = queryClient.getQueryData<Appointment>(detailKey);
      const previousLists = queryClient.getQueriesData<Pages>({
        queryKey: appointmentKeys.lists(tenantId),
      });
      if (previousRecord) {
        queryClient.setQueryData<Appointment>(detailKey, {
          ...previousRecord,
          status,
          ...(change.kind === 'cancel'
            ? {
                cancellation: {
                  reason: change.body.reason,
                  ...(change.body.note ? { note: change.body.note } : {}),
                },
              }
            : {}),
        });
      }
      queryClient.setQueriesData<Pages>({ queryKey: appointmentKeys.lists(tenantId) }, (data) =>
        data
          ? {
              ...data,
              pages: data.pages.map((page) => ({
                ...page,
                items: page.items.map((item) => (item.id === id ? { ...item, status } : item)),
              })),
            }
          : data,
      );
      return { previousRecord, previousLists };
    },
    onError: (_error, _variables, context) => {
      if (!context || !sameSession()) return;
      // Put back what was there before the change was shown.
      queryClient.setQueryData(detailKey, context.previousRecord);
      for (const [key, data] of context.previousLists as [QueryKey, Pages | undefined][]) {
        queryClient.setQueryData(key, data);
      }
    },
    onSuccess: (record) => {
      attempt.current = undefined;
      if (sameSession()) queryClient.setQueryData(detailKey, record);
    },
    onSettled: () => {
      if (!sameSession()) return;
      return queryClient.invalidateQueries({ queryKey: appointmentKeys.all(tenantId) });
    },
  });

  return {
    ...mutation,
    /** Sends a change. Resolves with the record as saved, or rejects with the refusal. */
    change: (change: AppointmentChange) => {
      const body = JSON.stringify(change);
      if (attempt.current?.body !== body) {
        attempt.current = { body, key: crypto.randomUUID() };
      }
      return mutation.mutateAsync({ change, key: attempt.current.key });
    },
  };
}
