import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SEARCH_DEBOUNCE_MS, useCandidates, useDebouncedValue } from '../hooks/use-doctors';
import type { DoctorCandidate } from '../types';

interface StaffPickerProps {
  selected: DoctorCandidate | null;
  onSelect: (candidate: DoctorCandidate) => void;
  /** Already translated. Shown when saving was tried with nobody chosen. */
  error?: string;
}

/**
 * Chooses the staff member a doctor profile is for, from those who have none yet. The server
 * searches; only the first few matches are listed, and typing narrows them.
 */
export function StaffPicker({ selected, onSelect, error }: StaffPickerProps) {
  const { t } = useTranslation('doctors');
  const searchId = useId();
  const errorId = useId();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const candidates = useCandidates(q, true);
  const found = candidates.data?.items ?? [];
  // The chosen person stays listed while the search moves on.
  const listed =
    selected && !found.some((candidate) => candidate.userId === selected.userId)
      ? [selected, ...found]
      : found;

  return (
    <fieldset
      className="flex flex-col gap-2"
      aria-describedby={error ? errorId : undefined}
      aria-invalid={error ? true : undefined}
    >
      <legend className="text-sm font-medium">{t('create.staffLegend')}</legend>
      <label htmlFor={searchId} className="sr-only">
        {t('create.staffSearch')}
      </label>
      <input
        id={searchId}
        type="search"
        value={search}
        maxLength={100}
        autoComplete="off"
        placeholder={t('create.staffSearchPlaceholder')}
        onChange={(event) => setSearch(event.target.value)}
        className="h-9 w-full rounded-md border bg-background px-3 text-base md:text-sm pointer-coarse:h-11"
      />
      {candidates.isPending && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('create.staffLoading')}
        </p>
      )}
      {candidates.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('create.staffFailed')}
        </p>
      )}
      {candidates.isSuccess && listed.length === 0 && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('create.staffNone')}
        </p>
      )}
      {listed.length > 0 && (
        <ul className="flex flex-col gap-1">
          {listed.map((candidate) => (
            <li
              key={candidate.userId}
              className="flex items-start gap-3 rounded-md border p-2 text-sm has-[:checked]:border-primary pointer-coarse:min-h-11"
            >
              <input
                id={`${searchId}-${candidate.userId}`}
                type="radio"
                name="doctor-staff-member"
                className="mt-1 h-4 w-4"
                checked={selected?.userId === candidate.userId}
                onChange={() => onSelect(candidate)}
              />
              <label
                htmlFor={`${searchId}-${candidate.userId}`}
                className="min-w-0 flex-1 cursor-pointer"
              >
                <span className="block font-medium break-words">{candidate.name}</span>
                <span className="block text-muted-foreground break-all">{candidate.email}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </fieldset>
  );
}
