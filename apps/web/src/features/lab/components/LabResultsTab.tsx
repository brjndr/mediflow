import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { DetailTab } from '@/features/patients';
import type { SlotProps } from '@/registry';
import { ReleasedResults } from './ReleasedResults';

/**
 * The "Lab results" tab of the patient's screen (`patient.detail.tabs`, #92), for
 * `labResult:read`: every released result of the patient, the newest collected first, a page at
 * a time, each numeric test's trend, and acknowledging a critical one. Given the patient's id
 * only, and reads nothing until the tab is opened.
 */
export default function LabResultsTab({ context }: SlotProps) {
  const { t } = useTranslation('lab');
  const canRead = usePermission('labResult:read');
  const patientId = typeof context?.patientId === 'string' ? context.patientId : '';
  if (!patientId || !canRead) return null;
  return (
    <DetailTab id="lab-results" title={t('released.tab')}>
      {/* Keyed by the patient: another patient's results or trend are never carried over. */}
      <PatientResults key={patientId} patientId={patientId} />
    </DetailTab>
  );
}

function PatientResults({ patientId }: { patientId: string }) {
  const { t } = useTranslation('lab');
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('released.patientHeading')}
      </h2>
      <ReleasedResults patientId={patientId} label={t('released.patientHeading')} withTrend />
    </section>
  );
}
