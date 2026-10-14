import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { todayIn } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import {
  bookableDays,
  MAX_REASON,
  RESCHEDULE_REASONS,
  rescheduleSchemaFor,
  type RescheduleValues,
} from '../schemas';
import type { Appointment } from '../types';
import { SlotPicker, type SlotRefusal } from './SlotPicker';

export interface RescheduleRefusal extends SlotRefusal {
  doctorId: string;
  day: string;
}

/**
 * Moving an appointment: the doctor (the same one unless another is chosen), a day, one of the
 * doctor's free times as the server lists them, and a reason. A time taken meanwhile is refused
 * as in booking, and the next free ones are offered.
 */
export function RescheduleForm({
  appointment,
  pending,
  refused,
  onSubmit,
  onChoiceChange,
  onBack,
}: {
  appointment: Appointment;
  pending: boolean;
  /** A refused time, and the doctor and day it was asked for. */
  refused?: RescheduleRefusal;
  onSubmit: (values: RescheduleValues) => Promise<void>;
  /** The doctor or the day was changed: a refusal of a time is no longer about this list. */
  onChoiceChange: () => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('appointments');
  const { t: tCommon } = useTranslation();
  const tenant = useTenant();
  const session = useSession();
  const timezone = tenant?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const days = bookableDays(today);
  const schema = useMemo(() => rescheduleSchemaFor(today), [today]);
  const doctors = useDoctorOptions();
  const mine = doctors.data?.find((doctor) => doctor.userId === session?.user.id);

  // It opens on the appointment's own day, unless that has passed.
  const ownDay = todayIn(timezone, new Date(appointment.startsAt));
  const form = useZodForm(schema, {
    doctorId: appointment.doctorId,
    day: ownDay >= days.first && ownDay <= days.last ? ownDay : today,
    startsAt: '',
    reason: '',
    note: '',
  });

  // A chosen time belongs to a doctor and a day: when either changes it is let go.
  useEffect(() => {
    const subscription = form.watch((_values, { name }) => {
      if (name !== 'doctorId' && name !== 'day') return;
      if (form.getValues('startsAt') !== '') form.setValue('startsAt', '');
      onChoiceChange();
    });
    return () => subscription.unsubscribe();
  }, [form, onChoiceChange]);

  const doctorId = String(form.watch('doctorId'));
  const day = String(form.watch('day'));

  // Without the doctors list the appointment stays with its doctor, who is offered by name.
  const options = doctors.data?.some((doctor) => doctor.id === appointment.doctorId)
    ? doctors.data
    : [{ id: appointment.doctorId, name: appointment.doctorName }, ...(doctors.data ?? [])];

  return (
    <Form form={form} onSubmit={onSubmit}>
      <SelectField<RescheduleValues>
        name="doctorId"
        label={t('book.doctor')}
        required
        options={options.map((doctor) => ({
          value: doctor.id,
          label: doctor.id === mine?.id ? t('filters.me', { name: doctor.name }) : doctor.name,
        }))}
      />
      {doctors.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(doctors.error))}
        </p>
      )}
      <TextField<RescheduleValues>
        name="day"
        type="date"
        label={t('book.day')}
        required
        min={days.first}
        max={days.last}
      />
      <SlotPicker
        refused={
          // Only while the doctor and the day are those it was about: changed while the request
          // was on its way, the form shows the new list and nothing else.
          refused && refused.doctorId === doctorId && refused.day === day ? refused : undefined
        }
        firstDay={days.first}
        lastDay={days.last}
      />
      <SelectField<RescheduleValues>
        name="reason"
        label={t('change.reason')}
        required
        placeholder={t('change.chooseReason')}
        options={RESCHEDULE_REASONS.map((value) => ({
          value,
          label: t(`change.rescheduleReasons.${value}`),
        }))}
      />
      <TextAreaField<RescheduleValues>
        name="note"
        label={t('change.note')}
        hint={t('change.noteHint')}
        maxLength={MAX_REASON}
        rows={3}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending}>
          {pending ? t('change.saving') : t('change.reschedule.submit')}
        </SubmitButton>
        <Button type="button" variant="outline" disabled={pending} onClick={onBack}>
          {t('change.back')}
        </Button>
      </div>
    </Form>
  );
}
