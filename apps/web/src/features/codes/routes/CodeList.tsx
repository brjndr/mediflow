import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { CodeSearch } from '../components/CodeSearch';
import {
  SEARCH_DEBOUNCE_MS,
  useCodeFavourite,
  useCodes,
  useDebouncedValue,
} from '../hooks/use-codes';
import { CODE_SYSTEMS } from '../schemas';
import type { Code, CodeSystem } from '../types';

const MANAGE = 'code:manage';
const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

function Codes() {
  const { t } = useTranslation('codes');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [system, setSystem] = useState<CodeSystem>('icd10');
  const [search, setSearch] = useState('');
  const [favourites, setFavourites] = useState(false);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const codes = useCodes({ system, q, favourites });
  const favourite = useCodeFavourite();
  // What was just done, or looked up, said once in a status line.
  const [done, setDone] = useState<string | null>(null);

  const rows = useMemo(() => codes.data?.pages.flatMap((page) => page.items) ?? [], [codes.data]);
  const total = codes.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Code>[]>(
    () => [
      { id: 'code', header: t('columns.code'), value: (row) => row.code, hideable: false },
      { id: 'title', header: t('columns.title'), value: (row) => row.title },
      {
        id: 'favourite',
        header: t('columns.favourite'),
        value: (row) => (row.favourite ? t('favourite') : ''),
      },
    ],
    [t],
  );

  const mark = (row: Code, next: boolean) => {
    setDone(null);
    favourite.mutate(
      { codeId: row.id, favourite: next },
      {
        onSuccess: () => setDone(t(next ? 'added' : 'removed', { code: row.code })),
      },
    );
  };
  const actions: GridAction<Code>[] = [
    {
      id: 'add',
      label: t('add'),
      requires: MANAGE,
      disabled: (row) => favourite.isPending || row.favourite,
      onSelect: (row) => mark(row, true),
    },
    {
      id: 'remove',
      label: t('remove'),
      requires: MANAGE,
      disabled: (row) => favourite.isPending || !row.favourite,
      onSelect: (row) => mark(row, false),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('filters.system')}
          <select
            value={system}
            onChange={(event) => {
              setDone(null);
              setSystem(CODE_SYSTEMS.find((value) => value === event.target.value) ?? 'icd10');
            }}
            className={control}
          >
            {CODE_SYSTEMS.map((value) => (
              <option key={value} value={value}>
                {t(`systems.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-sm font-medium">
          {t('filters.search')}
          <span className="relative">
            <Search
              aria-hidden="true"
              className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground"
            />
            <input
              type="search"
              value={search}
              maxLength={100}
              autoComplete="off"
              placeholder={t('filters.searchPlaceholder')}
              onChange={(event) => setSearch(event.target.value)}
              className={`${control} w-full pl-8 pr-3`}
            />
          </span>
        </label>
        <label className="flex h-9 items-center gap-2 text-sm font-medium pointer-coarse:h-11">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={favourites}
            onChange={(event) => setFavourites(event.target.checked)}
          />
          {t('filters.favouritesOnly')}
        </label>
      </div>

      {favourite.isError && (
        <p role="alert" className="text-sm text-destructive">
          {tCommon(errorMessageKey(favourite.error))}
        </p>
      )}
      <p role="status" className="text-sm text-muted-foreground">
        {done ?? ''}
      </p>
      <p role="status" className="text-sm text-muted-foreground">
        {/* Not while the previous filter's rows are still shown: the total would be theirs. */}
        {total === undefined || codes.isPlaceholderData
          ? ''
          : t(favourites ? 'countFavourites' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t(`systems.${system}`)}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.code}
        actions={actions}
        status={codes.isPending ? 'loading' : codes.isError ? 'error' : 'ready'}
        errorMessage={codes.isError ? tCommon(errorMessageKey(codes.error)) : undefined}
        onRetry={() => void codes.refetch()}
        emptyMessage={
          q.trim() !== '' ? t('emptySearch') : favourites ? t('emptyFavourites') : t('empty')
        }
        hasNextPage={codes.hasNextPage}
        loadingMore={codes.isFetchingNextPage}
        onLoadMore={() => void codes.fetchNextPage()}
      />

      <section
        aria-labelledby="code-search-box"
        className="flex flex-col gap-3 rounded-lg border p-4"
      >
        <div className="space-y-1">
          <h2 id="code-search-box" className="text-base font-semibold">
            {t('tryout.heading')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('tryout.description')}</p>
        </div>
        <div className="max-w-xl">
          <CodeSearch
            // A box for each code set: what was typed for one is not a search of the other.
            key={system}
            system={system}
            label={t(`tryout.label.${system}`)}
            onSelect={(code) => setDone(t('tryout.chosen', { code: code.code, title: code.title }))}
          />
        </div>
      </section>
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function CodeList() {
  return (
    <DesktopOnly>
      <Codes />
    </DesktopOnly>
  );
}
