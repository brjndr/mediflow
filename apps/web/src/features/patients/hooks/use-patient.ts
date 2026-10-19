import { useQuery } from '@tanstack/react-query';
import { isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { fetchPatient } from '../api';
import type { PatientSummary } from '../types';
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

/** Who a patient is, as another feature's screen names one it was given the id of. */
export type PatientName = Pick<PatientSummary, 'id' | 'firstName' | 'lastName' | 'mrn'>;

/**
 * The name and MRN of a patient whose id another feature's screen was given (issuing a queue
 * token from the patient's screen), and nothing more of the record. The same query as the
 * patient's screen, so coming from there asks the server for nothing again.
 */
export function usePatientName(id: string) {
  const { data: record, isPending, isError, error } = usePatient(id);
  const data: PatientName | undefined = record && {
    id: record.id,
    firstName: record.firstName,
    lastName: record.lastName,
    mrn: record.mrn,
  };
  // Not the query itself: its `refetch` would hand out the whole record.
  return { data, isPending, isError, error };
}
