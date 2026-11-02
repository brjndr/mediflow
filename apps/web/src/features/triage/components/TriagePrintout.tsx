import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';
import { useReadingLines } from '../hooks/use-reading-lines';
import type { PrintableTriage } from '../types';

/**
 * What triage found, as plain text for paper (#398): no screen styling, no marks against ranges.
 * A part not read (absent from `triage`) leaves no trace on the page.
 */
export function TriagePrintout({ triage }: { triage: PrintableTriage }) {
  const { t } = useTranslation('triage');
  const format = useFormatters();
  const lines = useReadingLines();
  const { allergies, vitals } = triage;
  return (
    <>
      {allergies && (
        <section className="mb-6 break-inside-avoid">
          <h2 className="mb-2 text-base font-semibold">{t('allergies.heading')}</h2>
          {allergies.status === 'listed' ? (
            <ul className="flex list-disc flex-col gap-1 pl-6">
              {allergies.items.map((item, index) => (
                <li key={index}>
                  <span className="font-medium">{item.substance}</span>
                  {t(item.reaction ? 'allergies.detailWithReaction' : 'allergies.detail', {
                    severity: t(`allergies.severities.${item.severity}`),
                    reaction: item.reaction,
                  })}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t(allergies.status === 'none' ? 'allergies.none' : 'print.allergiesNotAsked')}</p>
          )}
        </section>
      )}
      {vitals !== undefined && (
        <section className="mb-6 break-inside-avoid">
          <h2 className="mb-2 text-base font-semibold">{t('summary.latest')}</h2>
          {vitals === null ? (
            <p>{t('summary.noVitals')}</p>
          ) : (
            <>
              <p className="mb-1">
                {t('summary.recordedBy', {
                  time: format.dateTime(vitals.recordedAt),
                  name: vitals.recordedByName,
                })}
              </p>
              <ul className="flex list-disc flex-col gap-1 pl-6">
                {lines(vitals, undefined).map((line) => (
                  <li key={line.id}>
                    {t('print.measure', { measure: t(`measures.${line.id}`), value: line.text })}
                  </li>
                ))}
              </ul>
              {vitals.chiefComplaint && (
                <p className="mt-2 whitespace-pre-line">
                  {t('print.complaint', { complaint: vitals.chiefComplaint })}
                </p>
              )}
            </>
          )}
        </section>
      )}
    </>
  );
}
