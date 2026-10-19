import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import { useVitalRanges, useVitals } from '../hooks/use-triage';
import { AllergiesPanel } from './AllergiesPanel';
import { RangesNote, ReadingList } from './reading';

/** The patient's newest reading, marked against the ranges that apply to them. */
function LatestVitals({ patientId }: { patientId: string }) {
  const { t } = useTranslation('triage');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const vitals = useVitals(patientId, { limit: 1 });
  const ranges = useVitalRanges(patientId);
  const latest = vitals.data?.pages[0]?.items[0];
  return (
    <section aria-labelledby={`latest-${patientId}`} className="flex flex-col gap-3">
      <h2 id={`latest-${patientId}`} className="text-lg font-semibold">
        {t('summary.latest')}
      </h2>
      {vitals.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : vitals.isError ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(vitals.error))}
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void vitals.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : latest ? (
        <>
          <p className="text-sm text-muted-foreground">
            {t('summary.recordedBy', {
              time: format.dateTime(latest.recordedAt),
              name: latest.recordedByName,
            })}
          </p>
          <ReadingList reading={latest} ranges={ranges.data?.ranges} />
          <RangesNote ranges={ranges.data?.ranges} failed={ranges.isError} />
        </>
      ) : (
        <p>{t('summary.noVitals')}</p>
      )}
    </section>
  );
}

/**
 * What triage found for a patient: their allergies and their newest vitals, each shown to whoever
 * may read it. Exported for the consultation view (#80), which shows it beside the notes; renders
 * nothing while the `triage` switch is off.
 */
export function TriageSummary({ patientId }: { patientId: string }) {
  const on = useFeatureFlag('triage');
  const canReadVitals = usePermission('vitals:read');
  const canReadAllergies = usePermission('allergy:read');
  if (!on || (!canReadVitals && !canReadAllergies)) return null;
  return (
    <div className="flex flex-col gap-6">
      {canReadAllergies && <AllergiesPanel patientId={patientId} />}
      {canReadVitals && <LatestVitals patientId={patientId} />}
    </div>
  );
}
