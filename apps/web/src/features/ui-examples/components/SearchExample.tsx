import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ServerSearch } from '@/shared/ui/server-search';

const NAMES = ['Aspirin', 'Amoxicillin', 'Atenolol', 'Metformin', 'Omeprazole', 'Paracetamol'];

/** A stand-in for the server: an in-memory search of synthetic names, to show the box working. */
function useExampleSearch(typed: string, enabled: boolean) {
  return useQuery({
    queryKey: ['ui-examples', 'search', typed.trim().toLowerCase()],
    queryFn: () => NAMES.filter((name) => name.toLowerCase().includes(typed.trim().toLowerCase())),
    enabled: enabled && typed.trim() !== '',
  });
}

/**
 * `ServerSearch` with a made-up catalog. A real screen passes the hook of its own `POST …/search`
 * (see `ServiceSearch`), so the term travels in a body and never in an address.
 */
export function SearchExample() {
  const { t } = useTranslation('ui_examples');
  const [chosen, setChosen] = useState<string>();

  return (
    <section aria-labelledby="search-title" className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id="search-title" className="text-sm font-medium">
        {t('search.heading')}
      </h2>
      <ServerSearch
        label={t('search.label')}
        available
        useSearch={useExampleSearch}
        messages={{
          placeholder: t('search.placeholder'),
          unavailable: t('search.unavailable'),
          typeToSearch: t('search.typeToSearch'),
          loading: t('search.loading'),
          failed: t('search.failed'),
          none: () => t('search.none'),
          found: (count) => t('search.found', { count }),
        }}
        optionKey={(name) => name}
        renderOption={(name) => name}
        onChoose={(name, reset) => {
          setChosen(name);
          reset();
        }}
      />
      <p role="status" className="text-sm">
        {chosen ? t('search.chosen', { name: chosen }) : ''}
      </p>
    </section>
  );
}
