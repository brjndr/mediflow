import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { checkDuplicates, createPatient } from '../api';
import type { PatientCreate, PatientDuplicateQuery } from '../types';
import { patientDuplicatesKey, patientKeys } from './use-patients';

export function useCheckDuplicates() {
  return useMutation({
    mutationFn: (query: PatientDuplicateQuery) => checkDuplicates(query),
    // Nothing identifying stays in the mutation cache once the form is gone.
    gcTime: 0,
  });
}

export function useCreatePatient() {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id;
  return useMutation({
    gcTime: 0,
    mutationFn: ({ body, idempotencyKey }: { body: PatientCreate; idempotencyKey: string }) =>
      createPatient(body, idempotencyKey),
    onSuccess: () => {
      if (tenantId) return queryClient.invalidateQueries({ queryKey: patientKeys.lists(tenantId) });
    },
  });
}

/** How long the details must stay unchanged before a check is made for them. */
export const SUGGESTION_DEBOUNCE_MS = 600;

/**
 * Possible duplicates for details that are still being typed. Each check is a read of patient
 * data that the server audits, so it is made only once the details are complete, and `gcTime: 0`
 * keeps the details (which are in the key) and the answer no longer than the form.
 */
export function useDuplicateSuggestions(query: PatientDuplicateQuery | null) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: patientDuplicatesKey(tenantId ?? '', query),
    queryFn: ({ signal }) => checkDuplicates(query as PatientDuplicateQuery, signal),
    enabled: tenantId !== undefined && query !== null,
    staleTime: 30_000,
    gcTime: 0,
    // A suggestion is a convenience: if the check fails, saving still makes it.
    retry: false,
  });
}
