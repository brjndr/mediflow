import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import type { PatientDuplicateMatch } from '../types';
import { DuplicateMatchList } from './DuplicateSuggestions';

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
  return (
    <section role="alert" className="flex max-w-xl flex-col gap-4 rounded-lg border p-4">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{t('duplicate.heading')}</h2>
        <p className="text-sm text-muted-foreground">{t('duplicate.description')}</p>
      </div>
      <DuplicateMatchList matches={matches} />
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
