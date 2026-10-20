import { CalendarCheck, CalendarClock, CalendarX, CircleCheck } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';
import type { FollowUp } from '../types';

const ICONS = {
  due: CalendarClock,
  booked: CalendarCheck,
  attended: CircleCheck,
  cancelled: CalendarX,
} as const;

/**
 * Where a follow-up stands, in words with an icon, never colour alone: due (and since when it is
 * overdue, against today at the hospital), booked for a time, attended or cancelled.
 */
export function FollowUpState({ followUp, today }: { followUp: FollowUp; today?: string }) {
  const { t } = useTranslation('follow_ups');
  const format = useFormatters();
  const Icon = ICONS[followUp.state];
  const overdue = followUp.state === 'due' && today !== undefined && followUp.dueOn < today;
  const text =
    followUp.state === 'booked' && followUp.appointmentStartsAt
      ? t('state.bookedFor', { time: format.dateTime(followUp.appointmentStartsAt) })
      : overdue
        ? t('state.overdue')
        : t(`state.${followUp.state}`);
  return (
    <span className="inline-flex items-center gap-1">
      <Icon aria-hidden className="size-4 shrink-0" />
      {text}
    </span>
  );
}
