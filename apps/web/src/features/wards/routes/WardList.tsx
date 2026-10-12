import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue, useWards } from '../hooks/use-wards';
import type { Ward } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function Wards() {
  const { t } = useTranslation('wards');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [search, setSearch] = useState('');
  const [archived, setArchived] = useState(false);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const wards = useWards({ q, archived });

  const rows = useMemo(() => wards.data?.pages.flatMap((page) => page.items) ?? [], [wards.data]);
  const total = wards.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Ward>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => row.name,
        hideable: false,
        render: (row, text) => (
          <Link to={`/wards/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'code', header: t('columns.code'), value: (row) => row.code },
      { id: 'floor', header: t('columns.floor'), value: (row) => row.floor ?? '' },
      {
        id: 'department',
        header: t('columns.department'),
        value: (row) => row.departmentName ?? '',
      },
      {
        id: 'rooms',
        header: t('columns.rooms'),
        value: (row) => String(row.roomCount),
        align: 'end',
      },
      { id: 'beds', header: t('columns.beds'), value: (row) => String(row.bedCount), align: 'end' },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <div className="flex flex-wrap gap-6 pt-2">
          <Can permission="ward:manage">
            <Link to="/wards/new" className={`${link} text-sm underline`}>
              {t('add')}
            </Link>
          </Can>
          <Link to="/wards/categories" className={`${link} text-sm underline`}>
            {t('categoriesLink')}
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-4">
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
            checked={archived}
            onChange={(event) => setArchived(event.target.checked)}
          />
          {t('filters.showArchived')}
        </label>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {/* Not while the previous filter's rows are still shown: the total would be theirs. */}
        {total === undefined || wards.isPlaceholderData
          ? ''
          : t(archived ? 'countArchived' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={wards.isPending ? 'loading' : wards.isError ? 'error' : 'ready'}
        errorMessage={wards.isError ? tCommon(errorMessageKey(wards.error)) : undefined}
        onRetry={() => void wards.refetch()}
        emptyMessage={
          q.trim() !== '' ? t('emptySearch') : archived ? t('emptyArchived') : t('empty')
        }
        hasNextPage={wards.hasNextPage}
        loadingMore={wards.isFetchingNextPage}
        onLoadMore={() => void wards.fetchNextPage()}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function WardList() {
  return (
    <DesktopOnly>
      <Wards />
    </DesktopOnly>
  );
}
