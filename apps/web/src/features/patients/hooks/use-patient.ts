import { useQuery } from '@tanstack/react-query';
import { isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchPatient } from '../api';
import { patientKeys } from './use-patients';

/**
 * One patient's registration details. Keyed by the hospital, so the record is dropped with
 * everything else on a hospital switch and can never be shown in another hospital. Every load
 * is a read the server audits.
 */
export function usePatient(id: string) {
  const tenantId = useTenant()?.id;
  return useQuery({
    queryKey: patientKeys.detail(tenantId ?? '', id),
    queryFn: ({ signal }) => fetchPatient(id, signal),
    enabled: tenantId !== undefined && id !== '',
    staleTime: 15_000,
    // "No such patient" is an answer, not a failure to retry. Anything else gets one quick second
    // try before the screen says it could not load.
    retry: (failures, error) =>
      !(isApiError(error) && (error.code === 'not_found' || error.code === 'forbidden')) &&
      failures < 1,
    retryDelay: 400,
  });
}
