import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { todayIn, utcToZoned } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { useCheckIn } from '../hooks/use-queue-actions';

/** Refusals the desk can act on, by the server's code. Anything else is the common message. */
const REFUSED: Record<string, string> = {
  already_queued: 'checkIn.refused.alreadyQueued',
  already_checked_in: 'checkIn.refused.alreadyCheckedIn',
  not_today: 'checkIn.refused.notToday',
  invalid_transition: 'checkIn.refused.notScheduled',
  unknown_appointment: 'checkIn.refused.unavailable',
  unknown_patient: 'checkIn.refused.unavailable',
  unknown_doctor: 'checkIn.refused.unavailable',
  unknown_department: 'checkIn.refused.unavailable',
};

/**
 * "Check in" on today's scheduled appointment, contributed to the appointment list's rows
 * (`appointment.row.actions`) and to the appointment's own screen (`appointment.detail.actions`),
 * given the appointment's id, status and start only. Rendered for every row, so it reads no data:
 * whether the patient was checked in already is the server's answer, which gives the first token.
 * The manifest offers it to roles that hold `queue:create`; the answer names the patient, so it
 * also needs `patient:read`, as on the server.
 */
export default function CheckInAction({ context }: SlotProps) {
  const timezone = useTenant()?.timezone ?? 'UTC';
  const canReadPatients = usePermission('patient:read');
  const { appointmentId, status, startsAt } = context ?? {};
  if (!canReadPatients) return null;
  if (typeof appointmentId !== 'string' || typeof startsAt !== 'string') return null;
  if (status !== 'scheduled') return null;
  // Today at the hospital, not in the browser: the server checks the same.
  if (utcToZoned(startsAt, timezone).day !== todayIn(timezone)) return null;
  return <CheckIn appointmentId={appointmentId} startsAt={startsAt} />;
}

function CheckIn({ appointmentId, startsAt }: { appointmentId: string; startsAt: string }) {
  const { t } = useTranslation('queue');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const checkIn = useCheckIn();
  const outcome = useRef<HTMLSpanElement>(null);
  const done = checkIn.data;

  // The button goes away once the token is given: focus moves to what was done.
  useEffect(() => {
    if (done) focusIfLost(outcome.current);
  }, [done]);

  const code = isApiError(checkIn.error) ? checkIn.error.serverCode : undefined;
  const refused = code === undefined ? undefined : REFUSED[code];

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {!done && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={t('checkIn.label', { time: format.time(startsAt) })}
          aria-disabled={checkIn.isPending || undefined}
          onClick={() => {
            if (!checkIn.isPending) checkIn.mutate(appointmentId);
          }}
        >
          {checkIn.isPending ? t('checkIn.saving') : t('checkIn.action')}
        </Button>
      )}
      {/* Always there, so what was done is read when it is said; empty, it takes no room. */}
      <span ref={outcome} tabIndex={-1} role="status" className="text-sm empty:hidden">
        {done
          ? t(done.existing ? 'checkIn.existing' : 'checkIn.done', {
              number: done.token.number,
              department: done.token.departmentName,
            })
          : ''}
      </span>
      {checkIn.isError && (
        <span role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(checkIn.error))}
        </span>
      )}
    </span>
  );
}
