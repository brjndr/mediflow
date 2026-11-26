import { lazy, Suspense, useId } from 'react';
import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { Skeleton } from '@/shared/ui/skeleton';

// Loaded with the consultation that shows it, never with the app: the registry imports this
// module's index for the manifest.
const EncounterReports = lazy(() =>
  import('./EncounterReports').then((module) => ({ default: module.EncounterReports })),
);

export interface ImagingReportsPanelProps {
  encounterId: string;
}

/**
 * The signed imaging reports of a consultation (#1187), the newest first, for
 * `imagingReport:read` with radiology switched on; otherwise no trace of it and no request.
 * A draft never reaches it: the API gives signed reports only.
 */
export function ImagingReportsPanel({ encounterId }: ImagingReportsPanelProps) {
  const { t } = useTranslation('radiology');
  const headingId = useId();
  const canRead = usePermission('imagingReport:read');
  const on = useFeatureFlag('radiology');
  if (!canRead || !on) return null;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <h2 id={headingId} className="text-lg font-semibold">
        {t('encounter.heading')}
      </h2>
      <Suspense fallback={<Skeleton className="h-24 w-full" />}>
        <EncounterReports encounterId={encounterId} />
      </Suspense>
    </section>
  );
}
