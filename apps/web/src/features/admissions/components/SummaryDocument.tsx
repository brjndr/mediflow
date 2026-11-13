import { useTranslation } from 'react-i18next';
import { Letterhead, useFormatters } from '@/tenancy';
import { maskMrn } from '@/shared/utils/mask';
import { SUMMARY_SECTIONS, type Admission, type DischargeSummary } from '../types';

/** A section's text as paragraphs, line breaks kept; empty sections say so. */
function SectionText({ text, empty }: { text: string; empty: string }) {
  return text.trim() === '' ? (
    <p className="text-muted-foreground">{empty}</p>
  ) : (
    <p className="whitespace-pre-line break-words">{text}</p>
  );
}

/**
 * The signed summary as it reads on screen and on paper: who, when, the six sections, who signed
 * and the addenda below, each marked as added later. Plain text only: nothing is rendered as
 * markup. `print` shows the full MRN, as the other printed documents do.
 */
export function SummaryDocument({
  admission,
  summary,
  print = false,
}: {
  admission: Admission;
  summary: DischargeSummary;
  print?: boolean;
}) {
  const { t } = useTranslation('admissions');
  const format = useFormatters();
  return (
    <article className="flex flex-col gap-4" aria-label={t('summary.documentLabel')}>
      {print && <Letterhead />}
      <header className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">{t('summary.title')}</h2>
        <p>
          {admission.patientName} ({print ? admission.patientMrn : maskMrn(admission.patientMrn)})
        </p>
        <p className="text-sm">
          {t('summary.stay', {
            from: format.dateTime(admission.admittedAt),
            to: admission.dischargedAt
              ? format.dateTime(admission.dischargedAt)
              : t('summary.stillIn'),
            doctor: admission.doctorName,
          })}
        </p>
      </header>
      {SUMMARY_SECTIONS.map((section) => (
        <section key={section} className="flex flex-col gap-1">
          <h3 className="font-semibold">{t(`summary.sections.${section}`)}</h3>
          <SectionText text={summary[section]} empty={t('summary.noText')} />
        </section>
      ))}
      {summary.signedAt && (
        <p className="text-sm font-medium">
          {t('summary.signedBy', {
            name: summary.signedByName ?? '',
            at: format.dateTime(summary.signedAt),
          })}
        </p>
      )}
      {summary.addenda.length > 0 && (
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">{t('summary.addenda')}</h3>
          <ul className="flex flex-col gap-2">
            {summary.addenda.map((addendum) => (
              <li key={addendum.id} className="flex flex-col gap-0.5 border-l-2 pl-3">
                <p className="whitespace-pre-line break-words">{addendum.body}</p>
                <p className="text-sm text-muted-foreground print:text-black">
                  {t('summary.addendumBy', {
                    name: addendum.authorName,
                    at: format.dateTime(addendum.createdAt),
                  })}
                </p>
              </li>
            ))}
          </ul>
        </section>
      )}
    </article>
  );
}
