import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { todayIn, utcToZoned } from '@/shared/utils/timezone';
import { useFormatters, useTenant } from '@/tenancy';
import { useOpenEncounter } from '../hooks/use-clinical';
import type { EncounterCreate } from '../types';

/** Refusals the doctor can act on, by the server's code. Anything else is the common message. */
const REFUSED: Record<string, string> = {
  token_not_for_patient: 'start.refused.unavailable',
  unknown_appointment: 'start.refused.unavailable',
  unknown_patient: 'start.refused.unavailable',
  invalid_transition: 'start.refused.notScheduled',
  unknown_doctor: 'start.refused.noDoctor',
  already_open: 'start.refused.alreadyOpen',
};

/**
 * "Start consultation" on a token being served (`queue.row.actions`) and on today's scheduled
 * appointment (`appointment.row.actions`, `appointment.detail.actions`), given ids and values
 * only. Rendered for every row, so it reads no data: whether a consultation was started already
 * is the server's answer, which gives the one open for that token or appointment. The manifest
 * offers it to roles that hold `encounter:create` and `encounter:read`; opening also needs
 * `patient:read`, as on the server.
 */
export default function StartConsultationAction({ context }: SlotProps) {
  const timezone = useTenant()?.timezone ?? 'UTC';
  const canReadPatients = usePermission('patient:read');
  const { tokenId, appointmentId, patientId, status, number, startsAt } = context ?? {};
  if (!canReadPatients || typeof patientId !== 'string') return null;
  if (typeof tokenId === 'string') {
    // The patient the doctor has called in.
    if (status !== 'called') return null;
    return <Start body={{ patientId, queueTokenId: tokenId }} label={{ number }} />;
  }
  if (typeof appointmentId === 'string' && typeof startsAt === 'string') {
    if (status !== 'scheduled') return null;
    // Today at the hospital, not in the browser.
    if (utcToZoned(startsAt, timezone).day !== todayIn(timezone)) return null;
    return <Start body={{ patientId, appointmentId }} label={{ startsAt }} />;
  }
  return null;
}

function Start({
  body,
  label,
}: {
  body: EncounterCreate;
  label: { number?: unknown; startsAt?: string };
}) {
  const { t } = useTranslation('clinical');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const open = useOpenEncounter();
  const code = isApiError(open.error) ? open.error.serverCode : undefined;
  const refused = code === undefined ? undefined : REFUSED[code];

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        type="button"
        size="sm"
        aria-label={
          label.startsAt
            ? t('start.labelAppointment', { time: format.time(label.startsAt) })
            : t('start.labelToken', { number: label.number })
        }
        aria-disabled={open.isPending || undefined}
        onClick={() => {
          if (open.isPending) return;
          open.mutate(body, {
            onSuccess: (encounter) => void navigate(`/encounters/${encounter.id}`),
          });
        }}
      >
        {open.isPending ? t('start.saving') : t('start.action')}
      </Button>
      {open.isError && (
        <span role="alert" className="text-sm text-destructive">
          {refused ? t(refused) : tCommon(errorMessageKey(open.error))}
        </span>
      )}
    </span>
  );
}
