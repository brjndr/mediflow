import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, useZodForm } from '@/shared/ui/form';
import { useCrossmatch, usePatientBloodGroup, useScreening } from '../hooks/use-blood';
import {
  crossmatchFormSchema,
  SCREENING_RESULTS,
  SCREENING_TESTS,
  screeningFormSchema,
  type CrossmatchFormValues,
  type ScreeningFormValues,
} from '../schemas';
import type { BloodCrossmatch, BloodScreening, BloodUnit } from '../types';
import { useFailure } from './helpers';

/** The five infection tests of a unit in testing, each negative or reactive, recorded once. */
export function ScreeningDialog({
  unit,
  onClose,
  onDone,
}: {
  unit: BloodUnit;
  onClose: () => void;
  onDone: (screening: BloodScreening) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const screening = useScreening();
  const form = useZodForm(screeningFormSchema, {
    hiv: 'negative',
    hbv: 'negative',
    hcv: 'negative',
    syphilis: 'negative',
    malaria: 'negative',
  });
  const values = form.watch();
  const reactive = SCREENING_TESTS.some((test) => values[test] === 'reactive');
  const failure = useFailure(screening.error);

  const submit = async (body: ScreeningFormValues) => {
    try {
      onDone(await screening.mutateAsync({ unitId: unit.id, body }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('screening.title', { number: unit.unitNumber })}
      description={t('screening.description')}
      closeLabel={t('close')}
      busy={screening.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            type="submit"
            form="blood-screening-form"
            variant={reactive ? 'destructive' : 'default'}
            aria-disabled={screening.isPending}
          >
            {screening.isPending ? t('screening.saving') : t('screening.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-screening-form" onSubmit={submit}>
        {SCREENING_TESTS.map((test) => (
          <SelectField<ScreeningFormValues>
            key={test}
            name={test}
            label={t(`screening.tests.${test}`)}
            required
            options={SCREENING_RESULTS.map((value) => ({
              value,
              label: t(`screening.results.${value}`),
            }))}
          />
        ))}
        {/* Always on the page, so a screen reader reads the warning when it appears. */}
        <p
          role="status"
          className={
            reactive
              ? 'flex items-start gap-2 rounded-md bg-warning-soft p-3 text-sm font-medium text-warning-soft-foreground'
              : 'sr-only'
          }
        >
          {reactive && <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />}
          {reactive ? t('screening.reactiveWarning') : ''}
        </p>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}

/** Tests an available unit against a patient: good for 72 hours, judged by the server. */
export function CrossmatchDialog({
  unit,
  onClose,
  onDone,
}: {
  unit: BloodUnit;
  onClose: () => void;
  onDone: (crossmatch: BloodCrossmatch) => void;
}) {
  const { t } = useTranslation('blood-bank');
  const crossmatch = useCrossmatch();
  const [patient, setPatient] = useState<PatientSummary | null>(null);
  const [missing, setMissing] = useState(false);
  const group = usePatientBloodGroup(patient?.id);
  const form = useZodForm(crossmatchFormSchema, { result: 'compatible' });
  const failure = useFailure(crossmatch.error);

  const submit = async ({ result }: CrossmatchFormValues) => {
    if (!patient) {
      setMissing(true);
      return;
    }
    try {
      onDone(await crossmatch.mutateAsync({ unitId: unit.id, patientId: patient.id, result }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('crossmatch.title', { number: unit.unitNumber })}
      description={t('crossmatch.description', { group: unit.bloodGroup })}
      closeLabel={t('close')}
      busy={crossmatch.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="blood-crossmatch-form" aria-disabled={crossmatch.isPending}>
            {crossmatch.isPending ? t('crossmatch.saving') : t('crossmatch.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="blood-crossmatch-form" onSubmit={submit}>
        {patient ? (
          <div className="flex flex-wrap items-center gap-2">
            <p role="status" className="text-sm">
              {t('reserve.chosen', { name: `${patient.firstName} ${patient.lastName}` })}
            </p>
            <Button type="button" variant="outline" onClick={() => setPatient(null)}>
              {t('reserve.change')}
            </Button>
          </div>
        ) : (
          <PatientSearch
            label={t('reserve.patient')}
            required
            focusOnMount
            onSelect={(chosen) => {
              setPatient(chosen);
              setMissing(false);
            }}
          />
        )}
        {patient && (
          <p role="status" className="text-sm">
            {group.isPending
              ? t('crossmatch.groupLoading')
              : group.data?.bloodGroup
                ? t('crossmatch.groupIs', { group: group.data.bloodGroup })
                : group.isError
                  ? t('crossmatch.groupUnavailable')
                  : t('crossmatch.groupNone')}
          </p>
        )}
        <SelectField<CrossmatchFormValues>
          name="result"
          label={t('crossmatch.result')}
          required
          hint={t('crossmatch.validity')}
          options={[
            { value: 'compatible', label: t('crossmatch.results.compatible') },
            { value: 'incompatible', label: t('crossmatch.results.incompatible') },
          ]}
        />
        {missing && (
          <p role="alert" className="text-sm text-destructive">
            {t('reserve.missing')}
          </p>
        )}
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
