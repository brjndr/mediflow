import { lazy, Suspense, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { Skeleton } from '@/shared/ui/skeleton';

// The list loads with the consultation that shows it, never with the app: the registry imports
// this module's index for the manifest.
const ReleasedResults = lazy(() =>
  import('./ReleasedResults').then((module) => ({ default: module.ReleasedResults })),
);

export interface LabResultsPanelProps {
  encounterId: string;
  patientId: string;
}

/**
 * The lab results of a consultation (#92): the encounter's released results, the newest
 * collected first, a critical one not yet acknowledged said first. For `labResult:read` with the
 * laboratory switched on; otherwise no trace of it and no request.
 */
export function LabResultsPanel({ encounterId, patientId }: LabResultsPanelProps) {
  const { t } = useTranslation('lab');
  const headingId = useId();
  const canRead = usePermission('labResult:read');
  const on = useFeatureFlag('laboratory');
  if (!canRead || !on) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('released.encounterHeading')}
      </h2>
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <ReleasedResults
          patientId={patientId}
          encounterId={encounterId}
          label={t('released.encounterHeading')}
        />
      </Suspense>
    </section>
  );
}
