import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTenant } from '@/tenancy';
import { checkDuplicates, createPatient } from '../api';
import type { PatientCreate, PatientDuplicateQuery } from '../types';
import { patientKeys } from './use-patients';

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
