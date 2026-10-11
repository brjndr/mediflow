import { useTranslation } from 'react-i18next';
import { useFormatters } from '@/tenancy';
import { useDuplicateSuggestions } from '../hooks/use-register-patient';
import type { PatientDuplicateMatch, PatientDuplicateQuery } from '../types';

/** Possible matches, masked: enough to recognise a patient, not to read their details. */
export function DuplicateMatchList({ matches }: { matches: PatientDuplicateMatch[] }) {
  const { t } = useTranslation('patients');
  const format = useFormatters();
  return (
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
  );
}

/**
 * Says, while the form is still being filled in, that someone like this is already registered.
 * It only informs: the check that stops a second record is the one made on saving. Nothing is
 * shown until there is a match, and a check that fails is not an error the person has to deal
 * with here.
 */
export function DuplicateSuggestions({ query }: { query: PatientDuplicateQuery | null }) {
  const { t } = useTranslation('patients');
  const suggestions = useDuplicateSuggestions(query);
  const matches = suggestions.data?.items ?? [];
  return (
    // Always in the page, so a screen reader announces matches when they appear.
    <section aria-live="polite" className="max-w-xl">
      {query && matches.length > 0 && (
        <div className="flex flex-col gap-2 rounded-lg border border-amber-500/50 bg-amber-500/5 p-3">
          <h2 className="text-sm font-semibold">
            {t('suggestions.heading', { count: matches.length })}
          </h2>
          <p className="text-sm text-muted-foreground">{t('suggestions.description')}</p>
          <DuplicateMatchList matches={matches} />
        </div>
      )}
    </section>
  );
}
