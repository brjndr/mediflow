import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { AmendmentsList } from './AmendmentsList';

/**
 * The "Amendments" tab of the patient's screen (`patient.detail.tabs`, #1181), for
 * `correction:read`: what approved corrections added to this patient's record, to their visits
 * and to their documents, each naming its record. Given the patient's id only, and reads nothing
 * until the tab is opened.
 */
export default function AmendmentsTab({ context }: SlotProps) {
  const { t } = useTranslation('records');
  const canRead = usePermission('correction:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || !canRead) return null;
  return (
    <DetailTab id="amendments" title={t('amendments.tab')}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-muted-foreground">{t('amendments.intro')}</p>
        {/* Keyed by the patient: another patient's amendments are never carried over. */}
        <AmendmentsList key={patientId} patientId={patientId} label={t('amendments.tab')} />
      </div>
    </DetailTab>
  );
}
