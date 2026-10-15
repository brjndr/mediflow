import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useSearchParams } from 'react-router-dom';
import { useFeatureFlag, usePermission } from '@/access';
import { useSession } from '@/app/session';
import { useDoctorOptions } from '@/features/doctors';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { Slot } from '@/registry';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldError,
  useFieldFocusRef,
  useFieldValue,
  useSetFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { todayIn, zonedToUtc, type DayString } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { SlotPicker, type SlotRefusal } from '../components/SlotPicker';
import { useBookAppointment } from '../hooks/use-book-appointment';
import { bookableDays, bookingSchemaFor, MAX_REASON, type BookingValues } from '../schemas';
import type { Appointment, AppointmentCreate } from '../types';

function toRequest(values: BookingValues): AppointmentCreate {
  const reason = values.reason.trim();
  // A contributed field typed into and cleared again is left out, and so is a part left empty.
  const extensions = Object.fromEntries(
    Object.entries(values.extensions)
      .map(([id, part]) => [
        id,
        Object.fromEntries(Object.entries(part).filter(([, v]) => v !== '')),
      ])
      .filter(([, part]) => Object.keys(part as object).length > 0),
  );
  return {
    patientId: values.patientId,
    doctorId: values.doctorId,
    startsAt: values.startsAt,
    ...(reason ? { reason } : {}),
    ...(Object.keys(extensions).length > 0 ? { extensions } : {}),
  };
}

/** A day that exists, as `YYYY-MM-DD`: the 31st of February has the shape but is no day. */
function isCalendarDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/**
 * What the calendar asked to book (`?doctorId&day&time`, from a free time chosen on it): ids, a
 * day and a time, never anything about a patient. Anything malformed is ignored.
 */
function askedFrom(params: URLSearchParams): { doctorId?: string; day?: DayString; time?: string } {
  const doctorId = params.get('doctorId') ?? '';
  const day = params.get('day') ?? '';
  const time = params.get('time') ?? '';
  return {
    ...(/^[\w-]{1,64}$/.test(doctorId) ? { doctorId } : {}),
    ...(isCalendarDay(day) ? { day } : {}),
    ...(/^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? { time } : {}),
  };
}

/** Why a booking was refused, when the person can do something about it on this form. */
type Refusal =
  /** The time was taken first, or left the doctor's hours: the next free times are offered. */
  | ({ kind: 'slot' } & SlotRefusal)
  /** The patient already has an appointment at that time. */
  | { kind: 'patient_overlap' };

/** The chosen patient, or the box to find one. The form holds the id; the name is for show. */
function PatientChoice({
  patient,
  onChange,
  focusSearch,
}: {
  patient: PatientSummary | undefined;
  onChange: (patient: PatientSummary | undefined) => void;
  /** Whether the search box takes focus when it appears ("Book another"). */
  focusSearch: boolean;
}) {
  const { t } = useTranslation('appointments');
  const setValue = useSetFieldValue();
  const error = useFieldError('patientId');
  // Not a kit field: a failed submit still focuses it first, as the first field of the form.
  const focusRef = useFieldFocusRef('patientId');
  const errorId = 'book-patient-error';
  // The card of the chosen patient: its button takes focus after a patient is chosen.
  const card = useRef<HTMLDivElement>(null);
  // Where focus goes when one control replaces the other, so it is never left on the page.
  const [moved, setMoved] = useState(false);
  useEffect(() => {
    if (moved && patient) card.current?.querySelector('button')?.focus();
  }, [moved, patient]);

  const choose = (next: PatientSummary | undefined) => {
    setMoved(true);
    onChange(next);
    setValue('patientId', next?.id ?? '');
  };

  return (
    <div ref={focusRef} className="flex flex-col gap-1.5">
      {patient ? (
        <>
          <p className="text-sm font-medium">{t('book.patient')}</p>
          <div
            ref={card}
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3"
          >
            <div className="min-w-0">
              <p className="break-words font-medium">
                {patient.firstName} {patient.lastName}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('book.patientMrn', { mrn: patient.mrn })}
              </p>
            </div>
            <Button type="button" variant="outline" onClick={() => choose(undefined)}>
              {t('book.changePatient')}
            </Button>
          </div>
        </>
      ) : (
        <PatientSearch
          label={t('book.patient')}
          onSelect={choose}
          describedBy={error ? errorId : undefined}
          focusOnMount={moved || focusSearch}
          required
        />
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

/** Other features' booking fields, given the chosen doctor and day: ids and values only. */
function ExtensionFields() {
  const doctorId = String(useFieldValue('doctorId') ?? '');
  const day = String(useFieldValue('day') ?? '');
  return <Slot id="appointment.form.fields" context={{ doctorId, day }} />;
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function AppointmentBook() {
  const { t } = useTranslation('appointments');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const session = useSession();
  const timezone = tenant?.timezone ?? 'UTC';
  const today = todayIn(timezone);
  const doctors = useDoctorOptions();
  // Read once, when the screen opens: what the calendar asked for is a starting point only.
  const [params] = useSearchParams();
  const [asked] = useState(() => askedFrom(params));
  // The time asked for, chosen once if the doctor's free times on that day list it.
  const [preferred] = useState(() =>
    asked.doctorId && asked.day && asked.time
      ? {
          doctorId: asked.doctorId,
          day: asked.day,
          startsAt: zonedToUtc(asked.day, asked.time, timezone),
        }
      : undefined,
  );
  // Finding a patient is the patients feature's: switched on, and open to this person.
  const canReadPatients = usePermission('patient:read');
  const patientsOn = useFeatureFlag('patients');
  const canFindPatients = canReadPatients && patientsOn;
  const book = useBookAppointment();
  const mine = doctors.data?.find((doctor) => doctor.userId === session?.user.id);

  const days = bookableDays(today);
  const schema = useMemo(() => bookingSchemaFor(today), [today]);
  const form = useZodForm(schema, {
    patientId: '',
    doctorId: asked.doctorId ?? '',
    day: asked.day ?? today,
    startsAt: '',
    reason: '',
    extensions: {},
  });
  // Kept in memory only, never in the address or browser storage.
  const [patient, setPatient] = useState<PatientSummary>();
  const [refusal, setRefusal] = useState<Refusal>();
  const [booked, setBooked] = useState<Appointment>();
  const [another, setAnother] = useState(false);
  // A key identifies one request body: an identical resubmit (double click, retry) reuses it and
  // cannot book twice, while another time or patient gets a new key.
  const attempt = useRef<{ body: string; key: string }>(undefined);
  const heading = useRef<HTMLHeadingElement>(null);

  // A doctor books into their own schedule first, once the doctors are known, unless a doctor
  // was already chosen. A doctor asked for who is not listed is let go.
  const mineId = mine?.id;
  const listed = doctors.data;
  useEffect(() => {
    if (!listed) return;
    const current = form.getValues('doctorId');
    if (current !== '' && !listed.some((doctor) => doctor.id === current)) {
      form.setValue('doctorId', mineId ?? '');
    } else if (current === '' && mineId) {
      form.setValue('doctorId', mineId);
    }
  }, [listed, mineId, form]);

  // A chosen time belongs to a doctor and a day: when either changes it is let go, so a time of
  // another doctor's day can never be booked by mistake.
  useEffect(() => {
    const subscription = form.watch((_values, { name }) => {
      // Another time chosen: a refusal of the patient's time is no longer about it.
      if (name === 'startsAt' && form.getValues('startsAt') !== '') {
        setRefusal((now) => (now?.kind === 'patient_overlap' ? undefined : now));
      }
      if (name !== 'doctorId' && name !== 'day') return;
      if (form.getValues('startsAt') !== '') form.setValue('startsAt', '');
      setRefusal(undefined);
    });
    return () => subscription.unsubscribe();
  }, [form]);

  // After booking, move focus to the confirmation so a screen reader announces it.
  useEffect(() => {
    if (booked) heading.current?.focus();
  }, [booked]);

  const submit = async (values: BookingValues) => {
    book.reset();
    setRefusal(undefined);
    const body = toRequest(values);
    const serialized = JSON.stringify(body);
    if (attempt.current?.body !== serialized) {
      attempt.current = { body: serialized, key: crypto.randomUUID() };
    }
    try {
      const appointment = await book.mutateAsync({ body, idempotencyKey: attempt.current.key });
      attempt.current = undefined;
      setBooked(appointment);
    } catch (error) {
      if (!isApiError(error)) return;
      // A refusal of a time is about the doctor and day it was asked for. If either was changed
      // while the request was on its way, the form shows another list and the refusal is moot.
      const sameChoice =
        form.getValues('doctorId') === values.doctorId && form.getValues('day') === values.day;
      if (error.serverCode === 'slot_taken' || error.serverCode === 'outside_hours') {
        book.reset();
        if (!sameChoice) return;
        // The free times are asked for again (the booking invalidated them) and the next ones
        // after the chosen time are offered. What was typed stays.
        form.setValue('startsAt', '');
        setRefusal({
          kind: 'slot',
          reason: error.serverCode === 'slot_taken' ? 'taken' : 'outside_hours',
          after: values.startsAt,
        });
      } else if (error.serverCode === 'patient_overlap') {
        setRefusal({ kind: 'patient_overlap' });
        book.reset();
      }
      // Anything else is shown from the mutation state.
    }
  };

  const bookAnother = () => {
    setAnother(true);
    setBooked(undefined);
    setPatient(undefined);
    setRefusal(undefined);
    book.reset();
    form.reset({
      patientId: '',
      doctorId: form.getValues('doctorId'),
      day: form.getValues('day'),
      startsAt: '',
      reason: '',
      extensions: {},
    });
  };

  if (booked) {
    return (
      <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {t('book.booked.heading')}
        </h1>
        <p role="status">
          {t('book.booked.summary', {
            patient: booked.patientName,
            doctor: booked.doctorName,
            when: format.dateTime(booked.startsAt),
          })}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={bookAnother}>
            {t('book.booked.another')}
          </Button>
          <Button asChild variant="outline">
            <Link to="/appointments">{t('book.back')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const unavailable = !doctors.available
    ? 'book.unavailable.doctors'
    : !canFindPatients
      ? 'book.unavailable.patients'
      : null;

  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('book.heading')}</h1>
        <p className="text-muted-foreground">{t('book.description')}</p>
      </div>

      {unavailable ? (
        <div className="flex flex-col items-start gap-3">
          <p role="alert" className="text-sm">
            {t(unavailable)}
          </p>
          <Button asChild variant="outline">
            <Link to="/appointments">{t('book.back')}</Link>
          </Button>
        </div>
      ) : (
        <Form form={form} onSubmit={submit}>
          <PatientChoice
            patient={patient}
            focusSearch={another}
            onChange={(next) => {
              setPatient(next);
              if (refusal?.kind === 'patient_overlap') setRefusal(undefined);
            }}
          />
          <SelectField<BookingValues>
            name="doctorId"
            label={t('book.doctor')}
            required
            placeholder={doctors.isPending ? t('book.doctorsLoading') : t('book.chooseDoctor')}
            options={(doctors.data ?? []).map((doctor) => ({
              value: doctor.id,
              label: doctor.id === mine?.id ? t('filters.me', { name: doctor.name }) : doctor.name,
            }))}
          />
          {doctors.isError && (
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(doctors.error))}
            </p>
          )}
          <TextField<BookingValues>
            name="day"
            type="date"
            label={t('book.day')}
            required
            min={days.first}
            max={days.last}
          />
          <SlotPicker
            refused={refusal?.kind === 'slot' ? refusal : undefined}
            preferred={preferred}
            firstDay={days.first}
            lastDay={days.last}
          />
          <TextAreaField<BookingValues>
            name="reason"
            label={t('book.reason')}
            hint={t('book.reasonHint')}
            maxLength={MAX_REASON}
            rows={3}
          />
          <ExtensionFields />

          {refusal?.kind === 'patient_overlap' && (
            <p role="alert" className="text-sm text-destructive">
              {t('book.patientOverlap')}
            </p>
          )}
          {book.isError && (
            <p role="alert" className="text-sm text-destructive">
              {tCommon(errorMessageKey(book.error))}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <SubmitButton pending={book.isPending}>
              {book.isPending ? t('book.submitting') : t('book.submit')}
            </SubmitButton>
            <Button asChild variant="outline">
              <Link to="/appointments">{t('book.cancel')}</Link>
            </Button>
          </div>
        </Form>
      )}
    </div>
  );
}
