import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { buttonVariants } from '@/shared/ui/button';

/**
 * "Merge a duplicate" on the patient's screen, contributed through `patient.detail.actions` for
 * `patient:merge`. The address carries the surviving patient's id only.
 */
export default function MergeAction({ context }: SlotProps) {
  const { t } = useTranslation('patients');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId) return null;
  return (
    <Link
      to={`/patients/${encodeURIComponent(patientId)}/merge`}
      className={buttonVariants({ variant: 'outline' })}
    >
      {t('merge.action')}
    </Link>
  );
}
