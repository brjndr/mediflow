import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDoctorOptions } from '@/features/doctors';
import { PatientSearch, type PatientSummary } from '@/features/patients';
import { ServiceSearch, type ServiceOption } from '@/features/services';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { utcToZoned, zonedToUtc } from '@/shared/utils/timezone';
import { useTenant } from '@/tenancy';
import {
  useBookSurgery,
  useMoveSurgery,
  useRescheduleSurgery,
  useRooms,
} from '../hooks/use-theatre';
import {
  bookFormSchema,
  reasonFormSchema,
  rescheduleFormSchema,
  type BookFormValues,
  type ReasonFormValues,
  type RescheduleFormValues,
} from '../schemas';
import type { Surgery } from '../types';

const REFUSED: Record<string, string> = {
  room_taken: 'errors.room_taken',
  surgeon_busy: 'errors.surgeon_busy',
  patient_busy: 'errors.patient_busy',
  unknown_patient: 'errors.patient',
  unknown_room: 'errors.room',
  unknown_surgeon: 'errors.surgeon',
  unknown_service: 'errors.service',
  in_the_past: 'errors.past',
  invalid_time: 'errors.time',
  version_conflict: 'errors.changed',
  invalid_transition: 'errors.changed',
};

function failureText(
  error: unknown,
  t: (key: string) => string,
  tCommon: (key: string) => string,
): string | undefined {
  if (!error) return undefined;
  const code = isApiError(error) ? error.serverCode : undefined;
  return code !== undefined && REFUSED[code] ? t(REFUSED[code]) : tCommon(errorMessageKey(error));
}

function Failure({ text }: { text: string | undefined }) {
  return text ? (
    <p role="alert" className="text-sm text-destructive">
      {text}
    </p>
  ) : null;
}

/** The theatres in use and the practising doctors, as the two choices every booking needs. */
function useChoices() {
  const rooms = useRooms();
  const doctors = useDoctorOptions();
  return {
    rooms: (rooms.data ?? [])
      .filter((room) => !room.archived)
      .map((room) => ({ value: room.id, label: room.name })),
    surgeons: (doctors.data ?? []).map((doctor) => ({ value: doctor.id, label: doctor.name })),
  };
}

/**
 * Books a surgery (#176). Only the ids of the patient, theatre and surgeon are sent; the name
 * chosen is shown here and kept nowhere. The server refuses a theatre, surgeon or patient already
 * booked at that time, and that is said as it is.
 */
export function BookDialog({
  day,
  roomId,
  onClose,
  onBooked,
}: {
  day: string;
  roomId: string | undefined;
  onClose: () => void;
  onBooked: () => void;
}) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const book = useBookSurgery();
  const choices = useChoices();
  const [patient, setPatient] = useState<PatientSummary>();
  const [service, setService] = useState<ServiceOption>();
  const [missingPatient, setMissingPatient] = useState(false);
  const form = useZodForm(bookFormSchema, {
    roomId: roomId ?? '',
    surgeonId: '',
    procedure: '',
    notes: '',
    day,
    startTime: '09:00',
    endTime: '10:00',
  });

  const submit = async (values: BookFormValues) => {
    if (!patient) {
      setMissingPatient(true);
      return;
    }
    try {
      await book.mutateAsync({
        patientId: patient.id,
        roomId: values.roomId,
        surgeonId: values.surgeonId,
        ...(service ? { serviceId: service.id } : {}),
        procedure: values.procedure,
        ...(values.notes ? { notes: values.notes } : {}),
        startsAt: zonedToUtc(values.day, values.startTime, timezone),
        endsAt: zonedToUtc(values.day, values.endTime, timezone),
      });
      onBooked();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('book.title')}
      description={t('book.description')}
      closeLabel={t('close')}
      busy={book.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="theatre-book-form" aria-busy={book.isPending}>
            {book.isPending ? t('book.saving') : t('book.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="theatre-book-form" onSubmit={submit}>
        {patient ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">{t('book.patient')}</p>
              <p className="break-words">
                {patient.firstName} {patient.lastName}
              </p>
              <p className="text-xs text-muted-foreground">{patient.mrn}</p>
            </div>
            <Button type="button" variant="outline" onClick={() => setPatient(undefined)}>
              {t('book.changePatient')}
            </Button>
          </div>
        ) : (
          <>
            <PatientSearch
              label={t('book.patient')}
              onSelect={(chosen) => {
                setPatient(chosen);
                setMissingPatient(false);
              }}
            />
            {missingPatient && (
              <p role="alert" className="text-sm text-destructive">
                {t('book.choosePatient')}
              </p>
            )}
          </>
        )}
        <SelectField<BookFormValues>
          name="roomId"
          label={t('book.room')}
          required
          placeholder={t('book.chooseRoom')}
          options={choices.rooms}
        />
        <SelectField<BookFormValues>
          name="surgeonId"
          label={t('book.surgeon')}
          required
          placeholder={t('book.chooseSurgeon')}
          options={choices.surgeons}
        />
        <TextField<BookFormValues> name="procedure" label={t('book.procedure')} required />
        {service ? (
          <p className="text-sm">{t('book.service', { name: service.name })}</p>
        ) : (
          <ServiceSearch
            category="procedure"
            label={t('book.serviceSearch')}
            onSelect={(chosen) => setService(chosen)}
          />
        )}
        <TextField<BookFormValues> name="day" type="date" label={t('book.day')} required />
        <div className="grid grid-cols-2 gap-3">
          <TextField<BookFormValues>
            name="startTime"
            type="time"
            label={t('book.start')}
            required
          />
          <TextField<BookFormValues> name="endTime" type="time" label={t('book.end')} required />
        </div>
        <TextAreaField<BookFormValues> name="notes" label={t('book.notes')} />
        <Failure text={failureText(book.error, t, tCommon)} />
      </Form>
    </Dialog>
  );
}

/** Moves a scheduled surgery to another time, theatre or surgeon. */
export function RescheduleDialog({
  surgery,
  onClose,
  onMoved,
}: {
  surgery: Surgery;
  onClose: () => void;
  onMoved: () => void;
}) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const timezone = useTenant()?.timezone ?? 'UTC';
  const reschedule = useRescheduleSurgery();
  const choices = useChoices();
  const start = utcToZoned(surgery.startsAt, timezone);
  const end = utcToZoned(surgery.endsAt, timezone);
  const form = useZodForm(rescheduleFormSchema, {
    roomId: surgery.roomId,
    surgeonId: surgery.surgeonId,
    day: start.day,
    startTime: start.time,
    // A surgery over midnight is moved within one day here; the time is clipped to it.
    endTime: end.day === start.day ? end.time : '23:59',
  });

  const submit = async (values: RescheduleFormValues) => {
    try {
      await reschedule.mutateAsync({
        surgery,
        roomId: values.roomId,
        surgeonId: values.surgeonId,
        startsAt: zonedToUtc(values.day, values.startTime, timezone),
        endsAt: zonedToUtc(values.day, values.endTime, timezone),
      });
      onMoved();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('reschedule.title')}
      description={t('reschedule.description', { procedure: surgery.procedure })}
      closeLabel={t('close')}
      busy={reschedule.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="theatre-reschedule-form" aria-busy={reschedule.isPending}>
            {reschedule.isPending ? t('reschedule.saving') : t('reschedule.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="theatre-reschedule-form" onSubmit={submit}>
        <SelectField<RescheduleFormValues>
          name="roomId"
          label={t('book.room')}
          required
          placeholder={t('book.chooseRoom')}
          options={choices.rooms}
        />
        <SelectField<RescheduleFormValues>
          name="surgeonId"
          label={t('book.surgeon')}
          required
          placeholder={t('book.chooseSurgeon')}
          options={choices.surgeons}
        />
        <TextField<RescheduleFormValues> name="day" type="date" label={t('book.day')} required />
        <div className="grid grid-cols-2 gap-3">
          <TextField<RescheduleFormValues>
            name="startTime"
            type="time"
            label={t('book.start')}
            required
          />
          <TextField<RescheduleFormValues>
            name="endTime"
            type="time"
            label={t('book.end')}
            required
          />
        </div>
        <Failure text={failureText(reschedule.error, t, tCommon)} />
      </Form>
    </Dialog>
  );
}

/** Cancels a scheduled surgery, with the reason the server keeps. */
export function CancelDialog({
  surgery,
  onClose,
  onCancelled,
}: {
  surgery: Surgery;
  onClose: () => void;
  onCancelled: () => void;
}) {
  const { t } = useTranslation('theatre');
  const { t: tCommon } = useTranslation();
  const move = useMoveSurgery();
  const form = useZodForm(reasonFormSchema, { reason: '' });

  const submit = async (values: ReasonFormValues) => {
    try {
      await move.mutateAsync({ surgery, to: 'cancel', reason: values.reason });
      onCancelled();
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('cancelSurgery.title')}
      description={t('cancelSurgery.description', { procedure: surgery.procedure })}
      closeLabel={t('close')}
      busy={move.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancelSurgery.keep')}
          </Button>
          <Button type="submit" form="theatre-cancel-form" aria-busy={move.isPending}>
            {move.isPending ? t('cancelSurgery.saving') : t('cancelSurgery.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="theatre-cancel-form" onSubmit={submit}>
        <TextField<ReasonFormValues> name="reason" label={t('cancelSurgery.reason')} required />
        <Failure text={failureText(move.error, t, tCommon)} />
      </Form>
    </Dialog>
  );
}
