import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { buttonVariants } from '@/shared/ui/button';

/**
 * "Issue a token" on the patient's screen, contributed through `patient.detail.actions`: a walk-in
 * just registered is put in the queue without being searched for again. The address carries the
 * patient's id only. The manifest offers it to roles that hold `queue:create`.
 */
export default function IssueTokenAction({ context }: SlotProps) {
  const { t } = useTranslation('queue');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId) return null;
  return (
    <Link
      to={`/queue/new?patientId=${encodeURIComponent(patientId)}`}
      className={buttonVariants({ variant: 'outline' })}
    >
      {t('issue.fromPatient')}
    </Link>
  );
}
