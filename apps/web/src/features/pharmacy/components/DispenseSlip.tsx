import { useTranslation } from 'react-i18next';
import { Letterhead, useFormatters } from '@/tenancy';
import type { Dispense, PharmacyLine, PharmacyPrescription } from '../types';

/**
 * The dispense slip (#100), given with the medicine: the hospital's letterhead, who it is for, what
 * was given (a substitute says so, with the medicine prescribed), from which batches and their
 * expiry, how to take it as prescribed, and who dispensed it and when. Drawn by `PrintSheet`.
 */
export function DispenseSlip({
  prescription,
  line,
  dispense,
}: {
  prescription: PharmacyPrescription;
  line: PharmacyLine | undefined;
  dispense: Dispense;
}) {
  const { t } = useTranslation('pharmacy');
  const format = useFormatters();
  return (
    <>
      <Letterhead />
      <h1 className="mb-3 text-lg font-semibold">{t('slip.title')}</h1>
      <dl className="mb-6 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1">
        <dt className="font-medium">{t('slip.patient')}</dt>
        <dd>
          {t('detail.patient', { name: prescription.patientName, mrn: prescription.patientMrn })}
        </dd>
        <dt className="font-medium">{t('slip.prescribedBy')}</dt>
        <dd>
          {t('detail.prescribedBy', {
            name: prescription.prescribedByName,
            time: format.dateTime(prescription.prescribedAt),
          })}
        </dd>
        <dt className="font-medium">{t('slip.dispensed')}</dt>
        <dd>
          {t('slip.dispensedBy', {
            name: dispense.dispensedByName,
            time: format.dateTime(dispense.dispensedAt),
          })}
        </dd>
      </dl>
      <p className="font-semibold">
        {t('slip.item', { item: dispense.itemName, count: dispense.quantity })}
      </p>
      {dispense.substitutionReason && line && (
        <p>
          {t('slip.substitute', { prescribed: line.itemName, reason: dispense.substitutionReason })}
        </p>
      )}
      {line && (
        <p>
          {[
            t('dispense.dosage', { dose: line.dose, frequency: line.frequency }),
            t(`route.${line.route}`),
            line.durationDays === undefined ? '' : t('detail.days', { count: line.durationDays }),
            line.instructions ?? '',
          ]
            .filter(Boolean)
            .join('. ')}
        </p>
      )}
      <ul className="mt-3 list-disc pl-6">
        {dispense.batches.map((batch) => (
          <li key={batch.batchId}>
            {t('slip.batch', {
              number: batch.batchNumber,
              expiry: format.calendarDate(batch.expiryDate),
              count: batch.quantity,
            })}
          </li>
        ))}
      </ul>
      {prescription.advice && (
        <p className="mt-4 whitespace-pre-line">
          <span className="font-medium">{t('slip.advice')}</span> {prescription.advice}
        </p>
      )}
    </>
  );
}
