import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { buttonVariants } from '@/shared/ui/button';
import { usePatientSaving } from '../hooks/use-update-patient';

/**
 * The Edit button on the patient screen. Contributed through the `patient.detail.actions` slot
 * like any other feature's action, so the screen itself does not know about editing. The manifest
 * offers it only to roles that hold `patient:update`.
 */
export default function EditAction({ context }: SlotProps) {
  const { t } = useTranslation('patients');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  const saving = usePatientSaving(patientId);
  if (!patientId) return null;
  // One save at a time: the next edit has to start from the version this one produces.
  if (saving) {
    return (
      <span role="status" className="self-center text-sm text-muted-foreground">
        {t('edit.saving')}
      </span>
    );
  }
  return (
    <Link to={`/patients/${patientId}/edit`} className={buttonVariants({ variant: 'outline' })}>
      {t('edit.action')}
    </Link>
  );
}
