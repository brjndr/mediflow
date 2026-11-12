import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { Button } from '@/shared/ui/button';
import { ServerSearch } from '@/shared/ui/server-search';
import { useWardOptions } from '../hooks/use-board';
import type { WardOption } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

/** How many wards one search shows. */
const SEARCH_LIMIT = 25;

/** The search box's query: wards matching what was typed, asked for only once something is typed. */
function useWardSearch(typed: string, enabled: boolean) {
  const term = typed.trim();
  const found = useWardOptions(term, enabled && term !== '', SEARCH_LIMIT);
  return {
    data: found.data?.items,
    isError: found.isError,
    isPending: found.isPending,
    isPlaceholderData: found.isPlaceholderData,
  };
}

/**
 * Filter by ward. A hospital whose wards fit one page (100) gets a plain select; one with more
 * gets a search over the wards' code and name, answered by the server, and the chosen ward shown
 * with a button to clear it. Left out without `ward:read`. `onChange` gets the ward id, or ''
 * for every ward.
 */
export function WardFilter({
  value,
  onChange,
}: {
  value: string;
  onChange: (wardId: string) => void;
}) {
  const { t } = useTranslation('admissions');
  const mayWards = usePermission('ward:read');
  const all = useWardOptions('', mayWards);
  const [chosen, setChosen] = useState<WardOption | undefined>();

  if (!mayWards || !all.isSuccess) return null;

  if (!all.data.more) {
    return (
      <label className="flex min-w-52 flex-col gap-1 text-sm font-medium">
        {t('filters.ward')}
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className={control}
        >
          <option value="">{t('filters.allWards')}</option>
          {all.data.items.map((ward) => (
            <option key={ward.id} value={ward.id}>
              {ward.name}
            </option>
          ))}
        </select>
      </label>
    );
  }

  const shownName = value !== '' && chosen?.id === value ? chosen.name : undefined;
  return (
    <div className="flex min-w-52 flex-col gap-1 text-sm font-medium">
      <ServerSearch<WardOption>
        label={t('filters.ward')}
        available
        useSearch={useWardSearch}
        messages={{
          placeholder: t('wardSearch.placeholder'),
          unavailable: t('wardSearch.unavailable'),
          typeToSearch: t('wardSearch.typeToSearch'),
          loading: t('wardSearch.loading'),
          failed: t('wardSearch.failed'),
          none: () => t('wardSearch.none'),
          found: (count) => t('wardSearch.found', { count }),
        }}
        optionKey={(ward) => ward.id}
        renderOption={(ward) => ward.name}
        onChoose={(ward, reset) => {
          setChosen(ward);
          onChange(ward.id);
          reset();
        }}
      />
      <p className="flex items-center gap-2 font-normal">
        <span>
          {shownName === undefined
            ? t('filters.allWards')
            : t('wardSearch.chosen', { name: shownName })}
        </span>
        {value !== '' && (
          <Button type="button" variant="outline" size="sm" onClick={() => onChange('')}>
            {t('wardSearch.clear')}
          </Button>
        )}
      </p>
    </div>
  );
}
