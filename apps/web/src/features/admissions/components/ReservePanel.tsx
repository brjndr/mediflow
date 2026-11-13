import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PatientSearch, type PatientName } from '@/features/patients';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, useZodForm } from '@/shared/ui/form';
import { HOLD_HOURS, reserveSchema, type ReserveValues } from '../schemas';
import type { BoardBed } from '../types';

/**
 * Holds a bed for a patient who is not in it yet, for a length of time from a list. Part of the
 * page, opened from the bed's row: its heading takes focus, and it closes with its own button.
 * Until the time passes only that patient can be given the bed.
 */
export function ReservePanel({
  bed,
  pending,
  onSubmit,
  onBack,
}: {
  bed: BoardBed;
  pending: boolean;
  onSubmit: (patientId: string, hours: number) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('admissions');
  const [patient, setPatient] = useState<PatientName>();
  const [missing, setMissing] = useState(false);
  const form = useZodForm(reserveSchema, { hours: '24' });
  return (
    <section
      aria-labelledby="bed-reserve-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="bed-reserve-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('reservePanel.heading', { number: bed.number })}
      </h2>
      {patient ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
          <div className="min-w-0">
            <p className="break-words font-medium">
              {patient.firstName} {patient.lastName}
            </p>
            <p className="text-xs text-muted-foreground">
              {t('admit.patientMrn', { mrn: patient.mrn })}
            </p>
          </div>
          <Button type="button" variant="outline" onClick={() => setPatient(undefined)}>
            {t('admit.changePatient')}
          </Button>
        </div>
      ) : (
        <PatientSearch
          label={t('reservePanel.patient')}
          onSelect={(next) => {
            setPatient(next);
            setMissing(false);
          }}
          describedBy={missing ? 'bed-reserve-patient-error' : undefined}
          required
        />
      )}
      {missing && (
        <p id="bed-reserve-patient-error" role="alert" className="text-sm text-destructive">
          {t('reservePanel.patientRequired')}
        </p>
      )}
      <Form
        form={form}
        onSubmit={(values: ReserveValues) => {
          if (!patient) {
            setMissing(true);
            return;
          }
          onSubmit(patient.id, Number(values.hours));
        }}
      >
        <SelectField<ReserveValues>
          name="hours"
          label={t('reservePanel.hold')}
          required
          options={HOLD_HOURS.map((hours) => ({
            value: String(hours),
            label: t('reservePanel.hours', { count: hours }),
          }))}
        />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={pending}>{t('reservePanel.submit')}</SubmitButton>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
            onClick={onBack}
          >
            {t('reservePanel.back')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
