import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DayString } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import { createAppointment, fetchFreeSlots } from '../api';
import type { AppointmentCreate } from '../types';
import { appointmentKeys } from './use-appointments';

/** Under the feature's key, so a booking refreshes them with the lists. */
export const freeSlotsKey = (tenantId: string, doctorId: string, day: DayString) =>
  [...appointmentKeys.all(tenantId), 'free-slots', doctorId, day] as const;

/** Others book the same doctor all day: what was free a few seconds ago is asked for again. */
const FREE_SLOTS_STALE_MS = 5_000;

/** A doctor's free slots on a day at the hospital, as the server works them out. */
export function useFreeSlots(doctorId: string, day: DayString, enabled: boolean) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: freeSlotsKey(tenantId ?? '', doctorId, day),
    queryFn: ({ signal }) => fetchFreeSlots({ doctorId, day }, signal),
    enabled: enabled && doctorId !== '' && day !== '' && tenantId !== undefined,
    staleTime: FREE_SLOTS_STALE_MS,
  });
}

export function useBookAppointment() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    // Nothing about the patient stays in the mutation cache once the form is gone.
    gcTime: 0,
    mutationFn: ({ body, idempotencyKey }: { body: AppointmentCreate; idempotencyKey: string }) =>
      createAppointment(body, idempotencyKey),
    // Booked or refused, the lists and the free slots have changed: a refusal means someone
    // else took the slot.
    onSettled: () => {
      if (tenantId)
        return queryClient.invalidateQueries({ queryKey: appointmentKeys.all(tenantId) });
    },
  });
}

/**
 * For a feature that books through a route of its own (a follow-up, #88): the lists, the
 * calendar and the free times are read again, as after a booking here.
 */
export function useAppointmentsChanged() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return () => {
    if (tenantId) return queryClient.invalidateQueries({ queryKey: appointmentKeys.all(tenantId) });
  };
}
