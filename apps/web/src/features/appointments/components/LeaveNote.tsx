import { useTranslation } from 'react-i18next';
import { useLeaveOnDay } from '@/features/roster';
import { useFormatters } from '@/tenancy';

/**
 * Says so when the chosen doctor is on approved leave on the chosen day (the doctor's `userId`
 * and a calendar day of the hospital's clock). Shown only when the roster is on and open to this
 * person, and only then: it informs, it does not block (the slot list is still the truth).
 */
export function LeaveNote({ userId, name, day }: { userId?: string; name?: string; day?: string }) {
  const { t } = useTranslation('appointments');
  const format = useFormatters();
  const { leave } = useLeaveOnDay(userId, day);

  if (!leave) return null;
  return (
    <p role="status" className="rounded-md border p-3 text-sm">
      {t('book.onLeave', { name: name ?? leave.userName, time: format.dateTime(leave.endsAt) })}
    </p>
  );
}
