import { useTranslation } from 'react-i18next';
import { usePatientName } from '@/features/patients';

/** Who a claim is for: the name when the caller may read patients, else a plain word. */
export function ClaimPatient({ patientId }: { patientId: string }) {
  const { t } = useTranslation('insurance');
  const patient = usePatientName(patientId);
  if (patient.data) return <>{`${patient.data.firstName} ${patient.data.lastName}`}</>;
  return <>{t('claims.onRecord')}</>;
}
