import { useTranslation } from 'react-i18next';
import { useDoctorOptions } from '@/features/doctors';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { zonedToUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import { useDisposeCase } from '../hooks/use-emergency';
import {
  DISPOSITION_NOTE_MAX,
  DISPOSITIONS,
  dispositionFormSchema,
  type DispositionFormValues,
} from '../schemas';
import type { EmergencyCase } from '../types';
import { failureText } from './failure';

/** A `datetime-local` value, entered on the hospital's clock, as the instant to send. */
function instant(value: string, timezone: string): string {
  const [day = '', time = '00:00'] = value.split('T');
  return zonedToUtc(day, time.slice(0, 5), timezone);
}

/**
 * How the patient leaves the department (ER-02): discharged, admitted, referred elsewhere or
 * expired. Once decided it cannot be changed. Admitting needs the patient on record; the
 * server opens the inpatient admission and keeps the emergency record as it is.
 */
export function DispositionDialog({
  row,
  onClose,
  onDone,
}: {
  row: EmergencyCase;
  onClose: () => void;
  onDone: (done: EmergencyCase) => void;
}) {
  const { t } = useTranslation('emergency');
  const { t: tCommon } = useTranslation();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const dispose = useDisposeCase();
  const form = useZodForm(dispositionFormSchema, {
    type: 'discharge',
    note: '',
    destination: '',
    doctorId: '',
    deathAt: '',
  });
  const doctors = useDoctorOptions();
  const type = form.watch('type');
  const failure = failureText(dispose.error, t, tCommon);

  const submit = async (values: DispositionFormValues) => {
    try {
      const done = await dispose.mutateAsync({
        row,
        type: values.type,
        ...(values.note ? { note: values.note } : {}),
        ...(values.type === 'admit' && values.doctorId ? { doctorId: values.doctorId } : {}),
        ...(values.type === 'refer' ? { destination: values.destination } : {}),
        ...(values.type === 'expired' ? { deathAt: instant(values.deathAt, timezone) } : {}),
      });
      onDone(done);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('disposition.title')}
      description={t('disposition.description', { id: row.tempId })}
      closeLabel={t('close')}
      busy={dispose.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="emergency-disposition-form" aria-busy={dispose.isPending}>
            {dispose.isPending ? t('disposition.saving') : t('disposition.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="emergency-disposition-form" onSubmit={submit}>
        <SelectField<DispositionFormValues>
          name="type"
          label={t('disposition.type')}
          required
          options={DISPOSITIONS.map((value) => ({ value, label: t(`disposition.types.${value}`) }))}
        />
        {type === 'admit' && !row.patientId && (
          <p role="alert" className="text-sm text-destructive">
            {t('disposition.needsPatient')}
          </p>
        )}
        {type === 'admit' && doctors.available && doctors.data && (
          <SelectField<DispositionFormValues>
            name="doctorId"
            label={t('disposition.doctor')}
            hint={t('disposition.doctorHint')}
            placeholder={t('disposition.ownDoctor')}
            options={doctors.data.map((doctor) => ({ value: doctor.id, label: doctor.name }))}
          />
        )}
        {type === 'refer' && (
          <TextField<DispositionFormValues>
            name="destination"
            label={t('disposition.destination')}
            required
            maxLength={120}
            autoComplete="off"
          />
        )}
        {type === 'expired' && (
          <TextField<DispositionFormValues>
            name="deathAt"
            type="datetime-local"
            label={t('disposition.deathAt')}
            required
          />
        )}
        <TextAreaField<DispositionFormValues>
          name="note"
          label={t(type === 'admit' ? 'disposition.adviceNote' : 'disposition.note')}
          maxLength={DISPOSITION_NOTE_MAX}
        />
        <p className="text-sm text-muted-foreground">{t('disposition.final')}</p>
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
