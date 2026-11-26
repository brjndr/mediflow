import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Skeleton } from '@/shared/ui/skeleton';
import { RichTextView } from '@/shared/ui/rich-text';
import { useFormatters } from '@/tenancy';
import { useEncounterReports } from '../hooks/use-radiology';
import { ReportText } from './ReportText';

/**
 * The signed reports of one encounter's imaging orders, read only: who signed and when, the
 * technique, findings and impression, and the addenda added after. The caller checks
 * `imagingReport:read` and the switch.
 */
export function EncounterReports({ encounterId }: { encounterId: string }) {
  const { t } = useTranslation('radiology');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const reports = useEncounterReports(encounterId);

  if (reports.isPending) return <Skeleton className="h-24 w-full" />;
  if (reports.isError) {
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-sm">
        <p>{tCommon(errorMessageKey(reports.error))}</p>
        <Button type="button" variant="outline" onClick={() => void reports.refetch()}>
          {t('report.retry')}
        </Button>
      </div>
    );
  }
  if (reports.data.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('encounter.empty')}</p>;
  }
  return (
    <ul className="flex flex-col gap-4">
      {reports.data.map(({ itemName, report }) => (
        <li key={report.id} className="flex flex-col gap-3 rounded-lg border p-4">
          <h3 className="font-semibold break-words">{itemName}</h3>
          <p className="text-sm">
            {t('report.signedBy', {
              name: report.signedByName ?? '',
              time: report.signedAt ? format.dateTime(report.signedAt) : '',
            })}
          </p>
          <ReportText report={report} />
          {report.addenda.length > 0 && (
            <div className="flex flex-col gap-2">
              <h4 className="text-sm font-semibold">{t('report.addenda.heading')}</h4>
              <ol className="flex flex-col gap-3">
                {report.addenda.map((addendum) => (
                  <li key={addendum.id} className="flex flex-col gap-1 border-l-2 pl-3">
                    <p className="text-sm text-muted-foreground">
                      {t('report.addenda.by', {
                        reason: t(`report.addenda.reasons.${addendum.reason}`),
                        name: addendum.signedByName,
                        time: format.dateTime(addendum.signedAt),
                      })}
                    </p>
                    <RichTextView document={addendum.body} className="break-words" />
                  </li>
                ))}
              </ol>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
