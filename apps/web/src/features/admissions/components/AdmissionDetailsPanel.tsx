import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { maskPhone } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import type { Admission } from '../types';

/** What the desk recorded at admission: the doctor's advice, the attendant, the deposit and consents. */
export function AdmissionDetailsPanel({
  admission,
  onBack,
}: {
  admission: Admission;
  onBack: () => void;
}) {
  const { t } = useTranslation('admissions');
  const format = useFormatters();
  const none = t('details.none');
  const attendant = admission.attendantName
    ? [
        admission.attendantName,
        admission.attendantRelation ? t(`relations.${admission.attendantRelation}`) : '',
        admission.attendantPhone ? maskPhone(admission.attendantPhone) : '',
      ]
        .filter(Boolean)
        .join(', ')
    : none;
  const consents = admission.consents ?? [];
  return (
    <section
      aria-labelledby="admission-details-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="admission-details-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('details.heading', { patient: admission.patientName })}
      </h2>
      <dl className="grid gap-3 text-sm sm:grid-cols-[12rem_1fr]">
        <dt className="font-medium">{t('details.advice')}</dt>
        <dd className="whitespace-pre-wrap">{admission.adviceNote ?? none}</dd>
        <dt className="font-medium">{t('details.attendant')}</dt>
        <dd>{attendant}</dd>
        <dt className="font-medium">{t('details.deposit')}</dt>
        <dd>
          {admission.depositMinor !== undefined ? format.money(admission.depositMinor) : none}
        </dd>
        <dt className="font-medium">{t('details.consents')}</dt>
        <dd>
          {consents.length > 0 ? (
            <ul className="list-disc pl-5">
              {consents.map((consent) => (
                <li key={consent}>{t(`consentTypes.${consent}`)}</li>
              ))}
            </ul>
          ) : (
            none
          )}
        </dd>
      </dl>
      <div>
        <Button type="button" variant="outline" onClick={onBack}>
          {t('bedPanel.back')}
        </Button>
      </div>
    </section>
  );
}
