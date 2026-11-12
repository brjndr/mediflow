import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import type { SlotProps } from '@/registry';
import { buttonVariants } from '@/shared/ui/button';
import { ADMISSION_TYPES } from '../schemas';

/**
 * "Admit to hospital" on the patient's screen, the consultation and the emergency case,
 * contributed through `patient.detail.actions`, `encounter.detail.actions` and
 * `emergency.case.actions`. It opens the admit form with the patient filled. The address holds
 * the patient's id, an admission type and, from a consultation, that visit's id (the admission
 * keeps it as the visit it came from, #678), never a name. The host may pass `admitType` (the
 * emergency case passes `emergency`) and a `status`; a visit that is not open gets no link.
 */
export default function AdmitAction({ context }: SlotProps) {
  const { t } = useTranslation('admissions');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  const status = typeof context?.status === 'string' ? context.status : 'open';
  if (!patientId || status !== 'open') return null;
  const encounterId = typeof context?.encounterId === 'string' ? context.encounterId : '';
  const type = ADMISSION_TYPES.find((value) => value === context?.admitType);
  const query = new URLSearchParams({ patientId });
  if (type) query.set('type', type);
  if (encounterId) query.set('encounterId', encounterId);
  return (
    <Link
      to={`/admissions/new?${query.toString()}`}
      className={buttonVariants({ variant: 'outline' })}
    >
      {t('admit.fromHere')}
    </Link>
  );
}
