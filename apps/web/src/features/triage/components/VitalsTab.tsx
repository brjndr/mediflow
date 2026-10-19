import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { AllergiesPanel } from './AllergiesPanel';
import { VitalsHistory } from './VitalsHistory';

/**
 * The "Vitals and allergies" tab of the patient's screen (`patient.detail.tabs`). Given the
 * patient's id only. Reads nothing itself: what the tab shows is read when it is opened.
 */
export default function VitalsTab({ context }: SlotProps) {
  const { t } = useTranslation('triage');
  const canReadVitals = usePermission('vitals:read');
  const canReadAllergies = usePermission('allergy:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || (!canReadVitals && !canReadAllergies)) return null;
  return (
    <DetailTab id="vitals" title={t('tab')}>
      <div className="flex flex-col gap-6">
        {canReadAllergies && <AllergiesPanel patientId={patientId} />}
        {canReadVitals && <VitalsHistory patientId={patientId} />}
      </div>
    </DetailTab>
  );
}
