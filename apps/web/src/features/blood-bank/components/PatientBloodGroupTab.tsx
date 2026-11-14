import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, TextAreaField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { patientGroupFormSchema, type PatientGroupFormValues } from '../donor-schemas';
import { usePatientBloodGroup, useSetPatientBloodGroup } from '../hooks/use-blood';
import { BLOOD_GROUPS, REASON_MAX } from '../schemas';
import type { PatientBloodGroup } from '../types';
import { donorRefusalKey } from './refusal';

/**
 * The "Blood group" tab of the patient's screen (`patient.detail.tabs`, #586), for
 * `patient.bloodGroup:read`: the group on record and every entry before it, and a form to record
 * it (`patient.bloodGroup:update`). A different group than the one on record needs a reason; the
 * same group again changes nothing. Given the patient's id only, and reads nothing until shown.
 */
export default function PatientBloodGroupTab({ context }: SlotProps) {
  const { t } = useTranslation('blood-bank');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  const canRead = usePermission('patient.bloodGroup:read');
  if (!patientId || !canRead) return null;
  return (
    <DetailTab id="blood-group" title={t('patientGroup.tab')}>
      {/* Keyed by the patient: another patient's group is never carried over. */}
      <PatientGroup key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

function PatientGroup({ patientId }: { patientId: string }) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canUpdate = usePermission('patient.bloodGroup:update');
  const group = usePatientBloodGroup(patientId);

  return (
    <section aria-labelledby="patient-blood-group" className="flex flex-col gap-4">
      <h2 id="patient-blood-group" className="text-lg font-semibold">
        {t('patientGroup.heading')}
      </h2>
      {group.isPending && <p role="status">{t('patientGroup.loading')}</p>}
      {group.isError && (
        <div className="flex flex-wrap items-center gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(group.error))}
          </p>
          <Button variant="outline" onClick={() => void group.refetch()}>
            {t('retry')}
          </Button>
        </div>
      )}
      {group.data && (
        <>
          <p className="text-base">
            {group.data.bloodGroup
              ? t('patientGroup.current', { group: group.data.bloodGroup })
              : t('patientGroup.none')}
          </p>
          {group.data.history.length > 0 && (
            <ol className="flex flex-col gap-2" aria-label={t('patientGroup.history')}>
              {group.data.history.map((entry, index) => (
                <li key={`${entry.recordedAt}-${index}`} className="rounded-md border p-3 text-sm">
                  <p className="font-medium">
                    {entry.bloodGroup} · {format.dateTime(entry.recordedAt)}
                  </p>
                  {entry.reason && (
                    <p className="text-muted-foreground">
                      {t('history.reason')}: {entry.reason}
                    </p>
                  )}
                </li>
              ))}
            </ol>
          )}
          {canUpdate && <RecordGroupForm patientId={patientId} current={group.data} />}
        </>
      )}
    </section>
  );
}

function RecordGroupForm({
  patientId,
  current,
}: {
  patientId: string;
  current: PatientBloodGroup;
}) {
  const { t } = useTranslation('blood-bank');
  const { t: tCommon } = useTranslation();
  const record = useSetPatientBloodGroup();
  const [message, setMessage] = useState<string>();
  const form = useZodForm(patientGroupFormSchema, {
    bloodGroup: current.bloodGroup ?? ('' as PatientGroupFormValues['bloodGroup']),
    reason: '',
  });
  const chosen = form.watch('bloodGroup');
  const changing = current.bloodGroup !== undefined && chosen !== current.bloodGroup;

  const submit = async (values: PatientGroupFormValues) => {
    setMessage(undefined);
    // Said before asking: a changed group needs a reason (the server holds it too, 422).
    if (changing && values.reason === '') {
      form.setError('reason', { type: 'required', message: 'validation.required' });
      return;
    }
    try {
      const before = current.history.length;
      const next = await record.mutateAsync({
        patientId,
        body: {
          bloodGroup: values.bloodGroup,
          ...(changing && values.reason ? { reason: values.reason } : {}),
        },
      });
      setMessage(
        next.history.length === before
          ? t('patientGroup.unchanged', { group: values.bloodGroup })
          : t('patientGroup.saved', { group: values.bloodGroup }),
      );
      form.reset({ bloodGroup: values.bloodGroup, reason: '' });
    } catch {
      // Said below, from the mutation state.
    }
  };

  const key = record.isError ? donorRefusalKey(record.error) : null;

  return (
    <Form form={form} id="patient-group-form" onSubmit={submit} className="max-w-md gap-3">
      <h3 className="font-semibold">{t('patientGroup.record')}</h3>
      <SelectField<PatientGroupFormValues>
        name="bloodGroup"
        label={t('columns.group')}
        required
        placeholder={t('patientGroup.choose')}
        options={BLOOD_GROUPS.map((value) => ({ value, label: value }))}
      />
      <TextAreaField<PatientGroupFormValues>
        name="reason"
        label={t('patientGroup.reason')}
        hint={changing ? t('patientGroup.reasonNeeded') : t('patientGroup.reasonOptional')}
        required={changing}
        maxLength={REASON_MAX}
      />
      {record.isError && (
        <p role="alert" className="text-sm text-destructive">
          {key ? t(key) : tCommon(errorMessageKey(record.error))}
        </p>
      )}
      <p role="status" className="text-sm font-medium empty:sr-only">
        {message ?? ''}
      </p>
      <div>
        <Button type="submit" aria-disabled={record.isPending}>
          {record.isPending ? t('patientGroup.saving') : t('patientGroup.submit')}
        </Button>
      </div>
    </Form>
  );
}
