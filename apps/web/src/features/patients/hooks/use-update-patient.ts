import {
  useIsMutating,
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { sessionKey, useSession, type Session } from '@/app/session';
import { errorMessageKey, isApiError } from '@/shared/api';
import { useTenant } from '@/tenancy';
import { updatePatient } from '../api';
import type { PatientFormValues } from '../schemas';
import type { PatientRecord, PatientUpdate } from '../types';
import { patientDraftKey as draftKey, patientKeys } from './use-patients';

/**
 * An edit that has been sent but is not known to be saved: what the person typed, the record
 * they were looking at, and why the save failed if it did.
 *
 * It lives in the query cache under the hospital's key and nowhere else: in memory only, dropped
 * with everything else on a hospital switch or sign-out, and cleared as soon as the save succeeds.
 * That is what lets the screen go straight back to the record on save and still give the person
 * their typing back if the server refuses it.
 */
export interface PatientDraft {
  values: PatientFormValues;
  /** The record the edit was made from. */
  base: PatientRecord;
  /**
   * Whether the person could see contact details when they typed this. If that has changed by
   * the time the edit is looked at again, the contact fields of `values` mean something else
   * (empty because hidden, not because cleared) and are not used.
   */
  contact: boolean;
  failure?: {
    /** Someone else changed the record first. */
    conflict: boolean;
    /** Why, as a translation key. */
    messageKey: string;
  };
}

const detailKey = (tenantId: string, id: string) => patientKeys.detail(tenantId, id);
const saveKey = (tenantId: string, id: string) =>
  [...patientKeys.detail(tenantId, id), 'save'] as const;

/** The unsaved edit of a patient, if there is one. Never fetched: only ever set by a save. */
export function usePatientDraft(id: string) {
  const tenantId = useTenant()?.id ?? '';
  const queryClient = useQueryClient();
  const draft = useQuery<PatientDraft | null>({
    queryKey: draftKey(tenantId, id),
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
    // Kept for as long as the person stays signed in at this hospital, however long they are
    // away from the record: it is their unsaved work. Signing out or switching hospital drops it.
    gcTime: Infinity,
  });
  return {
    draft: draft.data ?? null,
    // Set to nothing rather than removed: a screen watching it is told at once.
    discard: () => queryClient.setQueryData(draftKey(tenantId, id), null),
  };
}

/** Whether a save of this patient is on its way to the server. */
export function usePatientSaving(id: string): boolean {
  const tenantId = useTenant()?.id ?? '';
  return useIsMutating({ mutationKey: saveKey(tenantId, id) }) > 0;
}

export interface PatientSave {
  body: PatientUpdate;
  /** The record as it will be if the save goes through, shown at once. */
  optimistic: PatientRecord;
  draft: PatientDraft;
}

const setRecord = (
  queryClient: QueryClient,
  tenantId: string,
  id: string,
  record: PatientRecord | undefined,
) => queryClient.setQueryData(detailKey(tenantId, id), record);

/**
 * Saves a change to one patient. The record shows the change at once; if the server refuses it
 * the record goes back to what it was and the edit is kept as a draft with the reason. A refusal
 * because someone else changed the record first also reads the record again.
 *
 * Everything that follows the request is done here, not by the screen that started it: that
 * screen has usually gone back to the record by the time the answer arrives.
 */
export function useUpdatePatient(id: string) {
  const queryClient = useQueryClient();
  const tenantId = useTenant()?.id ?? '';
  const userId = useSession()?.user.id;

  // The answer can arrive after the person has signed out, timed out or moved to another
  // hospital, when everything they had loaded has been dropped. Nothing is written then: it would
  // put a patient's record back in memory for whoever signs in next.
  const sameSession = () => {
    const session = queryClient.getQueryData<Session | null>(sessionKey);
    return (
      userId !== undefined && session?.user.id === userId && session.activeTenant?.id === tenantId
    );
  };

  return useMutation({
    // Lets the screens know a save of this patient is in flight (`usePatientSaving`).
    mutationKey: saveKey(tenantId, id),
    // The variables hold the edit. They go as soon as the request is over.
    gcTime: 0,
    mutationFn: ({ body }: PatientSave) => updatePatient(id, body),
    onMutate: async ({ optimistic, draft }) => {
      // A read in flight would put the old record back over the change.
      await queryClient.cancelQueries({ queryKey: detailKey(tenantId, id), exact: true });
      const previous = queryClient.getQueryData<PatientRecord>(detailKey(tenantId, id));
      queryClient.setQueryData(draftKey(tenantId, id), draft);
      setRecord(queryClient, tenantId, id, optimistic);
      return { previous };
    },
    onError: (error, { draft, optimistic }, context) => {
      if (!sameSession()) return;
      const conflict = isApiError(error) && error.code === 'conflict';
      queryClient.setQueryData<PatientDraft>(draftKey(tenantId, id), {
        ...draft,
        failure: { conflict, messageKey: errorMessageKey(error) },
      });
      // Put back what was there, unless something newer has been read since: then that stands.
      const shown = queryClient.getQueryData<PatientRecord>(detailKey(tenantId, id));
      if (shown === optimistic) setRecord(queryClient, tenantId, id, context?.previous);
      // After a conflict the record on screen is out of date: read what the other person saved.
      if (conflict || shown !== optimistic) {
        void queryClient.invalidateQueries({ queryKey: detailKey(tenantId, id), exact: true });
      }
    },
    onSuccess: (record) => {
      if (!sameSession()) return;
      setRecord(queryClient, tenantId, id, record);
      queryClient.setQueryData(draftKey(tenantId, id), null);
      // The name or MRN shown in the lists may have changed.
      void queryClient.invalidateQueries({ queryKey: patientKeys.lists(tenantId) });
    },
  });
}
