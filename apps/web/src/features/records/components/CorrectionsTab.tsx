import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Can, usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { Button } from '@/shared/ui/button';
import { CorrectionsGrid } from './CorrectionsGrid';
import { RequestCorrectionDialog } from './CorrectionDialogs';

/**
 * The "Corrections" tab of the patient's screen (`patient.detail.tabs`, #191), for
 * `correction:read`: the requests to correct this record with their reasons and what was decided.
 * `correction:request` asks for one; a correction is never a silent edit. Given the patient's id
 * only, and reads nothing until the tab is opened.
 */
export default function CorrectionsTab({ context }: SlotProps) {
  const { t } = useTranslation('records');
  const canRead = usePermission('correction:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || !canRead) return null;
  return (
    <DetailTab id="corrections" title={t('corrections.tab')}>
      {/* Keyed by the patient: another patient's requests are never carried over. */}
      <PatientCorrections key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

function PatientCorrections({ patientId }: { patientId: string }) {
  const { t } = useTranslation('records');
  const [asking, setAsking] = useState(false);
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">{t('corrections.tabIntro')}</p>
        <Can permission="correction:request">
          <Button onClick={() => setAsking(true)}>{t('corrections.request')}</Button>
        </Can>
      </div>
      <CorrectionsGrid status="" patientId={patientId} label={t('corrections.tab')} />
      {asking && (
        <RequestCorrectionDialog
          patientId={patientId}
          onClose={() => setAsking(false)}
          onRequested={() => setAsking(false)}
        />
      )}
    </div>
  );
}
