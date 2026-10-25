import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';
import { needsAcknowledging } from '../schemas';
import type { LabResult } from '../types';

/**
 * Where a critical result stands with the doctor (#92), in words: "Critical, not acknowledged"
 * with an icon, or who acknowledged it and when. Nothing for any other result.
 */
export function AcknowledgementWords({ result }: { result: LabResult }) {
  const { t } = useTranslation('lab');
  const format = useFormatters();
  if (needsAcknowledging(result)) {
    return (
      <span className="inline-flex items-center gap-1 font-semibold text-destructive">
        <TriangleAlert aria-hidden className="size-4 shrink-0" />
        {t('acknowledge.not')}
      </span>
    );
  }
  if (!result.acknowledgedAt) return null;
  return (
    <span className="text-muted-foreground">
      {t('acknowledge.by', {
        name: result.acknowledgedByName ?? '',
        time: format.dateTime(result.acknowledgedAt),
      })}
    </span>
  );
}
