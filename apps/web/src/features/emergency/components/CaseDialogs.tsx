import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, useZodForm } from '@/shared/ui/form';
import { useIdentifyCase, useTriageCase } from '../hooks/use-emergency';
import { CATEGORIES, TARGET_MINUTES } from '../schemas';
import type { EmergencyCase } from '../types';
import { failureText } from './failure';

const triageSchema = z.object({ category: z.enum(['1', '2', '3', '4', '5']) });
type TriageValues = z.infer<typeof triageSchema>;

/** Sets or changes the triage category (1 to 5) of a patient in the department. */
export function TriageDialog({
  row,
  onClose,
  onDone,
}: {
  row: EmergencyCase;
  onClose: () => void;
  onDone: (category: number) => void;
}) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const triage = useTriageCase();
  const form = useZodForm(triageSchema, {
    category: String(row.category ?? 3) as TriageValues['category'],
  });
  const failure = failureText(triage.error, t, tCommon);

  const submit = async (values: TriageValues) => {
    try {
      const done = await triage.mutateAsync({ row, category: Number(values.category) });
      onDone(done.category ?? Number(values.category));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('triage.title')}
      description={t('triage.description', { id: row.tempId })}
      closeLabel={t('close')}
      busy={triage.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="emergency-triage-form" aria-busy={triage.isPending}>
            {triage.isPending ? t('triage.saving') : t('triage.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="emergency-triage-form" onSubmit={submit}>
        <SelectField<TriageValues>
          name="category"
          label={t('triage.category')}
          required
          options={CATEGORIES.map((value) => ({
            value: String(value),
            label: `${t(`category.long.${value}`)} (${t('triage.target', { minutes: TARGET_MINUTES[value] })})`,
          }))}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** Links an unidentified patient to the record once they are known. */
export function IdentifyDialog({
  row,
  onClose,
  onDone,
}: {
  row: EmergencyCase;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const identify = useIdentifyCase();
  const [patient, setPatient] = useState<PatientSummary>();
  const failure = failureText(identify.error, t, tCommon);

  const submit = async () => {
    if (!patient) return;
    try {
      await identify.mutateAsync({ row, patientId: patient.id });
      onDone();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('identify.title')}
      description={t('identify.description', { id: row.tempId })}
      closeLabel={t('close')}
      busy={identify.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            aria-disabled={!patient || undefined}
            aria-busy={identify.isPending}
          >
            {identify.isPending ? t('identify.saving') : t('identify.save')}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {patient ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0">
              <p className="break-words">
                {patient.firstName} {patient.lastName}
              </p>
              <p className="text-xs text-muted-foreground">{patient.mrn}</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setPatient(undefined)}>
              {t('register.change')}
            </Button>
          </div>
        ) : (
          <PatientSearch
            label={t('register.patient')}
            required
            focusOnMount
            onSelect={setPatient}
          />
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </div>
    </Dialog>
  );
}
