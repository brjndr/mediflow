import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { Can, useAllowed } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import type { AppointmentChange } from '../api';
import { CancelForm } from '../components/CancelForm';
import { RescheduleForm, type RescheduleRefusal } from '../components/RescheduleForm';
import { STATUS_STYLE } from '../components/status';
import { useAppointment, useChangeAppointment } from '../hooks/use-appointment';
import { allowedChanges, type CancelValues, type RescheduleValues } from '../schemas';
import type { Appointment } from '../types';

type Panel = 'reschedule' | 'cancel' | 'complete' | 'no_show';

/** Refusals the person can understand from this screen, by the API's code. */
const REFUSALS: Record<string, string> = {
  conflict: 'change.refused.conflict',
  invalid_transition: 'change.refused.invalid_transition',
  too_early: 'change.refused.too_early',
  too_late: 'change.refused.too_late',
  patient_overlap: 'book.patientOverlap',
  unknown_doctor: 'change.refused.unknown_doctor',
};

/** Refusals after which the form is of no more use: the appointment is not what it was. */
const CLOSES_PANEL = new Set(['conflict', 'invalid_transition', 'too_late']);

/** The time, so the actions offered follow the clock: completing becomes possible at the start. */
function useNow(everyMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function Record({ appointment }: { appointment: Appointment }) {
  const { t } = useTranslation('appointments');
  const format = useFormatters();
  const canOpenPatient = useAllowed({ requires: 'patient:read', featureFlag: 'patients' });
  return (
    <dl className="grid gap-4 rounded-md border p-4 sm:grid-cols-2">
      <Field label={t('columns.patient')}>
        {canOpenPatient ? (
          // The patient's id only: never a name in an address.
          <Link to={`/patients/${appointment.patientId}`} className="font-medium underline">
            {appointment.patientName}
          </Link>
        ) : (
          <span className="font-medium">{appointment.patientName}</span>
        )}
        <span className="block text-sm text-muted-foreground">
          {t('book.patientMrn', { mrn: appointment.patientMrn })}
        </span>
      </Field>
      <Field label={t('columns.status')}>
        <span
          className={`rounded px-2 py-0.5 text-xs font-medium ${STATUS_STYLE[appointment.status]}`}
        >
          {t(`status.${appointment.status}`)}
        </span>
      </Field>
      <Field label={t('detail.when')}>
        {t('timeRange', {
          start: format.dateTime(appointment.startsAt),
          end: format.time(appointment.endsAt),
        })}
      </Field>
      <Field label={t('columns.doctor')}>
        {appointment.doctorName}
        {appointment.departmentName && (
          <span className="block text-sm text-muted-foreground">{appointment.departmentName}</span>
        )}
      </Field>
      <Field label={t('book.reason')}>
        <span className="whitespace-pre-line">{appointment.reason ?? t('detail.noReason')}</span>
      </Field>
      {appointment.cancellation && (
        <Field label={t('detail.cancelledBecause')}>
          {t(`change.cancelReasons.${appointment.cancellation.reason}`)}
          {appointment.cancellation.note && (
            <span className="block whitespace-pre-line text-sm text-muted-foreground">
              {appointment.cancellation.note}
            </span>
          )}
        </Field>
      )}
    </dl>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function AppointmentDetail() {
  const { t } = useTranslation('appointments');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const { appointmentId = '' } = useParams();
  const appointment = useAppointment(appointmentId);
  const change = useChangeAppointment(appointmentId);
  const now = useNow(30_000);
  const [panel, setPanel] = useState<Panel>();
  const [slotRefusal, setSlotRefusal] = useState<RescheduleRefusal>();
  // What happened last, as a key of this feature's strings: done, or refused and why.
  const [outcome, setOutcome] = useState<{ key: string; refused: boolean }>();
  const heading = useRef<HTMLHeadingElement>(null);
  const clearSlotRefusal = useCallback(() => setSlotRefusal(undefined), []);

  const open = (next: Panel | undefined) => {
    change.reset();
    setOutcome(undefined);
    setSlotRefusal(undefined);
    setPanel(next);
  };

  const send = async (next: AppointmentChange, choice?: RescheduleValues) => {
    setOutcome(undefined);
    setSlotRefusal(undefined);
    try {
      await change.change(next);
      setPanel(undefined);
      setOutcome({ key: `change.done.${next.kind}`, refused: false });
      heading.current?.focus();
    } catch (error) {
      if (!isApiError(error)) return;
      const code = error.serverCode ?? '';
      if (choice && (code === 'slot_taken' || code === 'outside_hours')) {
        // The free times are asked for again and the next ones after the refused time offered.
        change.reset();
        setSlotRefusal({
          reason: code === 'slot_taken' ? 'taken' : 'outside_hours',
          after: choice.startsAt,
          doctorId: choice.doctorId,
          day: choice.day,
        });
        return;
      }
      const key = REFUSALS[code];
      if (!key) return; // Shown from the mutation state.
      change.reset();
      setOutcome({ key, refused: true });
      if (CLOSES_PANEL.has(code)) setPanel(undefined);
    }
  };

  if (appointment.isPending) {
    return (
      <p role="status" className="px-4 py-6 text-sm text-muted-foreground">
        {t('detail.loading')}
      </p>
    );
  }
  if (appointment.isError) {
    const missing = isApiError(appointment.error) && appointment.error.status === 404;
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col items-start gap-3 px-4 py-6">
        <p role="alert" className="text-sm">
          {missing ? t('detail.notFound') : tCommon(errorMessageKey(appointment.error))}
        </p>
        <div className="flex flex-wrap gap-2">
          {!missing && (
            <Button type="button" variant="outline" onClick={() => void appointment.refetch()}>
              {t('calendar.retry')}
            </Button>
          )}
          <Button asChild variant="outline">
            <Link to="/appointments">{t('book.back')}</Link>
          </Button>
        </div>
      </div>
    );
  }

  const record = appointment.data;
  const allowed = allowedChanges(record, now);
  const version = record.version;
  const anyAllowed = Object.values(allowed).some(Boolean);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <h1 ref={heading} tabIndex={-1} className="text-2xl font-semibold tracking-tight">
          {t('detail.heading')}
        </h1>
        <Button asChild variant="outline">
          <Link to="/appointments">{t('book.back')}</Link>
        </Button>
      </div>

      <Record appointment={record} />

      {outcome && (
        <p
          role={outcome.refused ? 'alert' : 'status'}
          className={outcome.refused ? 'text-sm text-destructive' : 'text-sm'}
        >
          {t(outcome.key)}
        </p>
      )}
      {change.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(change.error))}
        </p>
      )}

      <Can permission="appointment:update">
        {anyAllowed && panel === undefined && (
          <div className="flex flex-wrap gap-2">
            {allowed.complete && (
              <Button type="button" onClick={() => open('complete')}>
                {t('change.complete.open')}
              </Button>
            )}
            {allowed.noShow && (
              <Button type="button" variant="outline" onClick={() => open('no_show')}>
                {t('change.no_show.open')}
              </Button>
            )}
            {allowed.reschedule && (
              <Button type="button" variant="outline" onClick={() => open('reschedule')}>
                {t('change.reschedule.open')}
              </Button>
            )}
            {allowed.cancel && (
              <Button type="button" variant="outline" onClick={() => open('cancel')}>
                {t('change.cancel.open')}
              </Button>
            )}
          </div>
        )}

        {(panel === 'complete' || panel === 'no_show') && (
          <section
            aria-labelledby="change-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2 id="change-heading" className="font-semibold">
              {t(`change.${panel}.heading`)}
            </h2>
            <p className="text-sm">
              {t(`change.${panel}.confirm`, { patient: record.patientName })}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                disabled={change.isPending}
                onClick={() => void send({ kind: panel, body: { version } })}
              >
                {change.isPending ? t('change.saving') : t(`change.${panel}.submit`)}
              </Button>
              <Button type="button" variant="outline" onClick={() => open(undefined)}>
                {t('change.back')}
              </Button>
            </div>
          </section>
        )}

        {panel === 'cancel' && (
          <section
            aria-labelledby="change-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2 id="change-heading" className="font-semibold">
              {t('change.cancel.heading')}
            </h2>
            <CancelForm
              pending={change.isPending}
              onBack={() => open(undefined)}
              onSubmit={(values: CancelValues) => {
                const note = values.note.trim();
                return send({
                  kind: 'cancel',
                  body: { version, reason: values.reason, ...(note ? { note } : {}) },
                });
              }}
            />
          </section>
        )}

        {panel === 'reschedule' && (
          <section
            aria-labelledby="change-heading"
            className="flex flex-col gap-3 rounded-md border p-4"
          >
            <h2 id="change-heading" className="font-semibold">
              {t('change.reschedule.heading')}
            </h2>
            <RescheduleForm
              appointment={record}
              pending={change.isPending}
              refused={slotRefusal}
              onChoiceChange={clearSlotRefusal}
              onBack={() => open(undefined)}
              onSubmit={(values) => {
                const note = values.note.trim();
                return send(
                  {
                    kind: 'reschedule',
                    body: {
                      version,
                      doctorId: values.doctorId,
                      startsAt: values.startsAt,
                      reason: values.reason,
                      ...(note ? { note } : {}),
                    },
                  },
                  values,
                );
              }}
            />
          </section>
        )}
      </Can>
    </div>
  );
}
