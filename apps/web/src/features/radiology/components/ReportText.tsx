import { useTranslation } from 'react-i18next';
import { isEmptyRichText, RichTextView, sanitizeRichText } from '@/shared/ui/rich-text';
import type { ImagingReport } from '../types';

/** The parts of a report as written, read only: those with no text are left out. */
export function ReportText({ report }: { report: ImagingReport }) {
  const { t } = useTranslation('radiology');
  const parts = [
    ['technique', report.technique],
    ['findings', report.findings],
    ['impression', report.impression],
  ] as const;
  return (
    <div className="flex flex-col gap-3">
      {parts.map(([part, document]) =>
        isEmptyRichText(sanitizeRichText(document)) ? null : (
          <div key={part} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">{t(`report.parts.${part}`)}</h3>
            <RichTextView document={document} className="break-words" />
          </div>
        ),
      )}
      {report.links.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-semibold">{t('report.links.heading')}</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {report.links.map((link, index) => (
              <li key={`${link.url}:${index}`} className="break-all">
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  {link.label}
                </a>{' '}
                <span className="text-muted-foreground">{t('report.links.opensElsewhere')}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
