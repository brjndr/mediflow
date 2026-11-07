import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { buttonVariants } from '@/shared/ui/button';

/**
 * "Book appointment" on the patient's screen, contributed through `patient.detail.actions`: the
 * front desk books the next visit without searching for the patient again. The address carries
 * the patient's id only, never a name. The manifest offers it to roles that hold
 * `appointment:create`, and only while the `appointments` switch is on.
 */
export default function BookAction({ context }: SlotProps) {
  const { t } = useTranslation('appointments');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId) return null;
  return (
    <Link
      to={`/appointments/new?patientId=${encodeURIComponent(patientId)}`}
      className={buttonVariants({ variant: 'outline' })}
    >
      {t('book.fromPatient')}
    </Link>
  );
}
