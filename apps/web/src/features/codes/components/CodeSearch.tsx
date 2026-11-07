import { useTranslation } from 'react-i18next';
import { useFeatureFlag, usePermission } from '@/access';
import { ServerSearch } from '@/shared/ui/server-search';
import { useCodeSuggestions } from '../hooks/use-codes';
import type { Code, CodeSystem } from '../types';

/**
 * A search box for a diagnosis or procedure code: type a code or words of its title, and choose
 * from what the server finds. Before anything is typed it offers the hospital's favourites.
 * The code set is searched on the server and is never in the bundle.
 *
 * For any screen that records a code (a diagnosis on a consultation, a procedure on an order).
 * It works with the keyboard (arrows, Enter, Escape), by touch, and at any width. It tells the
 * screen which code was chosen and keeps nothing itself. Built on `ServerSearch` (`shared/ui`).
 */
export function CodeSearch({
  system,
  label,
  onSelect,
}: {
  system: CodeSystem;
  /** Already translated: what the code is for on this screen. */
  label: string;
  onSelect: (code: Code) => void;
}) {
  const { t } = useTranslation('codes');
  // The codes are a module of their own: switched on for the hospital, and open to this person.
  // Without them the box says so and asks the server for nothing.
  const allowed = usePermission('code:read');
  const switchedOn = useFeatureFlag('codes');

  const useSearch = (typed: string, enabled: boolean) => useCodeSuggestions(system, typed, enabled);

  return (
    <ServerSearch
      label={label}
      available={allowed && switchedOn}
      searchOnEmpty
      listWhenEmpty
      useSearch={useSearch}
      messages={{
        placeholder: t('search.placeholder'),
        unavailable: t('search.unavailable'),
        loading: t('search.loading'),
        failed: t('search.failed'),
        none: (searching) => t(searching ? 'search.none' : 'search.noFavourites'),
        found: (count, searching) => t(searching ? 'search.found' : 'search.favourites', { count }),
      }}
      optionKey={(option) => option.id}
      renderOption={(option) => (
        <span className="flex w-full items-baseline gap-2">
          <span className="shrink-0 font-medium">{option.code}</span>
          <span className="min-w-0 break-words">{option.title}</span>
          {option.favourite && (
            <span className="ml-auto shrink-0 text-xs text-muted-foreground">{t('favourite')}</span>
          )}
        </span>
      )}
      onChoose={(option, reset) => {
        onSelect(option);
        reset();
      }}
    />
  );
}
