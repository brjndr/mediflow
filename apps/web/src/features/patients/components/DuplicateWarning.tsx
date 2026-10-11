import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import type { PatientDuplicateMatch } from '../types';

interface DuplicateWarningProps {
  matches: PatientDuplicateMatch[];
  pending: boolean;
  onRegisterAnyway: () => void;
  onBack: () => void;
}

/** Possible matches, masked: enough to recognise a patient, not to read their details. */
export function DuplicateWarning({
  matches,
  pending,
  onRegisterAnyway,
  onBack,
}: DuplicateWarningProps) {
  const { t } = useTranslation('patients');
  const format = useFormatters();
  return (
    <section role="alert" className="flex max-w-xl flex-col gap-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('duplicate.heading')}</h2>
        <p className="text-sm text-muted-foreground">{t('duplicate.description')}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {matches.map((match, index) => (
          <li key={index} className="rounded-md border p-3 text-sm">
            <span className="font-medium">
              {match.firstName} {match.lastName}
            </span>
            <span className="block text-muted-foreground">
              {t('duplicate.details', {
                mrn: match.maskedMrn,
                phone: match.maskedPhone,
                dob: format.date(`${match.dob}T12:00:00Z`),
              })}
            </span>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" disabled={pending} onClick={onBack}>
          {t('duplicate.back')}
        </Button>
        <Button disabled={pending} onClick={onRegisterAnyway}>
          {t('duplicate.registerAnyway')}
        </Button>
      </div>
    </section>
  );
}
