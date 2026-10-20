import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BOOK_AHEAD_DAYS,
  bookableDays,
  SlotPicker,
  type SlotRefusal,
} from '@/features/appointments';
import { useDoctorOptions } from '@/features/doctors';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { todayIn } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { useBookFollowUp } from '../hooks/use-follow-ups';
import { bookFormSchemaFor, type BookValues } from '../schemas';
import type { FollowUp } from '../types';

/** Refusals the person can do nothing about on this form, in words of their own. */
const REFUSED: Record<string, string> = {
  conflict: 'book.refused.conflict',
  invalid_transition: 'book.refused.notDue',
  follow_up_not_found: 'book.refused.gone',
  unknown_doctor: 'book.refused.unknownDoctor',
  patient_overlap: 'book.refused.patientOverlap',
};

/**
 * Books a due follow-up (#88) as an appointment of its patient: its doctor or another, a day of
 * the booking window (the due day when it is in it), and one of the doctor's free times, offered
 * by the appointments' `SlotPicker`. The server makes the appointment and links it in one step.
 * Shown in place, with `data-panel-heading` for the panel's focus, its heading one level below
 * the part of the page it is in.
 */
export function BookFollowUp({
  followUp,
  headingLevel = 3,
  onClose,
  onBooked,
}: {
  followUp: FollowUp;
  headingLevel?: 2 | 3;
  onClose: () => void;
  onBooked: (booked: FollowUp) => void;
}) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const { t } = useTranslation('follow_ups');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const days = bookableDays(today);
  const schema = useMemo(() => bookFormSchemaFor(days.first, days.last), [days.first, days.last]);
  const doctors = useDoctorOptions();
  const book = useBookFollowUp();
  const [refusal, setRefusal] = useState<SlotRefusal>();
  const firstDay =
    followUp.dueOn < days.first
      ? days.first
      : followUp.dueOn > days.last
        ? days.last
        : followUp.dueOn;
  const form = useZodForm(schema, { doctorId: followUp.doctorId, day: firstDay, startsAt: '' });

  // A time belongs to a doctor and a day: when either changes it is let go, and so is a refusal.
  useEffect(() => {
    const subscription = form.watch((_values, { name }) => {
      if (name !== 'doctorId' && name !== 'day') return;
      if (form.getValues('startsAt') !== '') form.setValue('startsAt', '');
      setRefusal(undefined);
    });
    return () => subscription.unsubscribe();
  }, [form]);

  // The follow-up's own doctor is always offered, also without the doctors list.
  const options = useMemo(() => {
    const listed = (doctors.data ?? []).map((doctor) => ({ value: doctor.id, label: doctor.name }));
    return listed.some((option) => option.value === followUp.doctorId)
      ? listed
      : [{ value: followUp.doctorId, label: followUp.doctorName }, ...listed];
  }, [doctors.data, followUp.doctorId, followUp.doctorName]);

  const submit = async (values: BookValues) => {
    book.reset();
    setRefusal(undefined);
    try {
      const booked = await book.mutateAsync({
        followUp,
        body: {
          startsAt: values.startsAt,
          version: followUp.version,
          ...(values.doctorId === followUp.doctorId ? {} : { doctorId: values.doctorId }),
        },
      });
      onBooked(booked);
    } catch (error) {
      if (!isApiError(error)) return;
      const sameChoice =
        form.getValues('doctorId') === values.doctorId && form.getValues('day') === values.day;
      if (error.serverCode === 'slot_taken' || error.serverCode === 'outside_hours') {
        // The free times are asked for again and the next ones after the time refused offered.
        book.reset();
        if (!sameChoice) return;
        form.setValue('startsAt', '');
        setRefusal({
          reason: error.serverCode === 'slot_taken' ? 'taken' : 'outside_hours',
          after: values.startsAt,
        });
      }
      // Anything else is said from the mutation state.
    }
  };

  const code = isApiError(book.error) ? book.error.serverCode : undefined;
  const failure = book.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(book.error))
    : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <Heading data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('book.heading', { name: followUp.patientName })}
      </Heading>
      <p className="text-sm text-muted-foreground">
        {followUp.dueOn > days.last
          ? t('book.beyondWindow', {
              day: format.calendarDate(followUp.dueOn),
              days: BOOK_AHEAD_DAYS,
            })
          : t('book.due', { day: format.calendarDate(followUp.dueOn) })}
      </p>
      <Form form={form} onSubmit={submit}>
        <SelectField<BookValues>
          name="doctorId"
          label={t('book.doctor')}
          required
          options={options}
        />
        <TextField<BookValues>
          name="day"
          type="date"
          label={t('book.day')}
          required
          min={days.first}
          max={days.last}
        />
        <SlotPicker refused={refusal} firstDay={days.first} lastDay={days.last} />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={book.isPending}>
            {book.isPending ? t('book.submitting') : t('book.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
