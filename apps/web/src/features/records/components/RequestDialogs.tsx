import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { useCloseRecordRequest, useCreateRecordRequest } from '../hooks/use-records';
import {
  closeFormSchema,
  REQUESTERS,
  requestFormSchema,
  type CloseFormValues,
  type RequestFormValues,
} from '../schemas';
import type { RecordRequest } from '../types';

const REFUSED: Record<string, string> = {
  version_conflict: 'requests.errors.conflict',
  already_closed: 'requests.errors.closed',
  patient_merged: 'requests.errors.merged',
};

function useFailure(error: unknown) {
  const { t } = useTranslation('records');
  const { t: tCommon } = useTranslation();
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  return code !== undefined && REFUSED[code] ? t(REFUSED[code]) : tCommon(errorMessageKey(error));
}

/** Logs a request for a patient's record: who asks, why, and by when it is due (MR-04, #192). */
export function NewRequestDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: RecordRequest) => void;
}) {
  const { t } = useTranslation('records');
  const create = useCreateRecordRequest();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const form = useZodForm(requestFormSchema, {
    requesterKind: 'patient',
    requesterName: '',
    purpose: '',
    dueOn: '',
  });
  const failure = useFailure(create.error);

  const submit = async (values: RequestFormValues) => {
    if (!patient) {
      setMissing(true);
      return;
    }
    try {
      onCreated(
        await create.mutateAsync({
          patientId: patient.id,
          requesterKind: values.requesterKind,
          requesterName: values.requesterName,
          purpose: values.purpose,
          ...(values.dueOn !== '' ? { dueOn: values.dueOn } : {}),
        }),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('requests.newTitle')}
      description={t('requests.newDescription')}
      closeLabel={t('close')}
      busy={create.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form="record-request-form"
            aria-busy={create.isPending}
            onClick={() => setMissing(patient === null)}
          >
            {create.isPending ? t('requests.logging') : t('requests.log')}
          </Button>
        </>
      }
    >
      <Form form={form} id="record-request-form" onSubmit={submit}>
        <div className="flex flex-col gap-1.5">
          {patient ? (
            <div className="flex flex-wrap items-center gap-2">
              <p role="status" className="text-sm">
                {t('requests.patientChosen', {
                  name: `${patient.firstName} ${patient.lastName}`,
                })}
              </p>
              <Button type="button" variant="outline" onClick={() => setPatient(null)}>
                {t('requests.changePatient')}
              </Button>
            </div>
          ) : (
            <PatientSearch
              label={t('requests.patient')}
              required
              onSelect={(chosen) => {
                setPatient(chosen);
                setMissing(false);
              }}
            />
          )}
          {missing && (
            <p role="alert" className="text-sm text-destructive">
              {t('requests.patientRequired')}
            </p>
          )}
        </div>
        <SelectField<RequestFormValues>
          name="requesterKind"
          label={t('requests.requesterKind')}
          required
          options={REQUESTERS.map((value) => ({ value, label: t(`requester.${value}`) }))}
        />
        <TextField<RequestFormValues>
          name="requesterName"
          label={t('requests.requesterName')}
          required
        />
        <TextAreaField<RequestFormValues> name="purpose" label={t('requests.purpose')} required />
        <TextField<RequestFormValues> name="dueOn" type="date" label={t('requests.dueOn')} />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** Closes an open request as fulfilled or declined, with a note, at the version read. */
export function CloseRequestDialog({
  request,
  onClose,
  onClosed,
}: {
  request: RecordRequest;
  onClose: () => void;
  onClosed: (closed: RecordRequest) => void;
}) {
  const { t } = useTranslation('records');
  const close = useCloseRecordRequest(request.id);
  const form = useZodForm(closeFormSchema, { outcome: 'fulfilled', note: '' });
  const failure = useFailure(close.error);

  const submit = async (values: CloseFormValues) => {
    try {
      onClosed(await close.mutateAsync({ ...values, version: request.version }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('requests.closeTitle', { name: request.patientName })}
      description={t('requests.closeDescription')}
      closeLabel={t('close')}
      busy={close.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="record-request-close" aria-busy={close.isPending}>
            {close.isPending ? t('requests.closing') : t('requests.closeSubmit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="record-request-close" onSubmit={submit}>
        <SelectField<CloseFormValues>
          name="outcome"
          label={t('requests.outcome')}
          required
          options={[
            { value: 'fulfilled', label: t('state.fulfilled') },
            { value: 'declined', label: t('state.declined') },
          ]}
        />
        <TextAreaField<CloseFormValues> name="note" label={t('requests.note')} required />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
