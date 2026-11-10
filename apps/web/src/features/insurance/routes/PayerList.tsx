import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/shared/hooks/use-debounced-value';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { usePayers } from '../hooks/use-payers';
import { PAYER_KINDS } from '../schemas';
import type { Payer, PayerKind } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function Payers() {
  const { t } = useTranslation('insurance');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<PayerKind | ''>('');
  const [archived, setArchived] = useState(false);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const payers = usePayers({ q, kind, archived });

  const rows = useMemo(() => payers.data?.pages.flatMap((page) => page.items) ?? [], [payers.data]);
  const total = payers.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Payer>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => row.name,
        hideable: false,
        render: (row, text) => (
          <Link to={`/insurance/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'code', header: t('columns.code'), value: (row) => row.code },
      { id: 'kind', header: t('columns.kind'), value: (row) => t(`kind.${row.kind}`) },
      { id: 'contact', header: t('columns.contact'), value: (row) => row.contactName ?? '' },
      {
        id: 'plans',
        header: t('columns.plans'),
        value: (row) => String(row.planCount),
        align: 'end',
      },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="payer:manage">
          <Link to="/insurance/new" className={`${link} pt-2 text-sm underline`}>
            {t('add')}
          </Link>
        </Can>
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
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('filters.kind')}
          <select
            value={kind}
            onChange={(event) => setKind(event.target.value as PayerKind | '')}
            className={control}
          >
            <option value="">{t('filters.anyKind')}</option>
            {PAYER_KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`kind.${value}`)}
              </option>
            ))}
          </select>
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
        {total === undefined || payers.isPlaceholderData
          ? ''
          : t(archived ? 'countArchived' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={payers.isPending ? 'loading' : payers.isError ? 'error' : 'ready'}
        errorMessage={payers.isError ? tCommon(errorMessageKey(payers.error)) : undefined}
        onRetry={() => void payers.refetch()}
        emptyMessage={
          q.trim() !== '' ? t('emptySearch') : archived ? t('emptyArchived') : t('empty')
        }
        hasNextPage={payers.hasNextPage}
        loadingMore={payers.isFetchingNextPage}
        onLoadMore={() => void payers.fetchNextPage()}
        total={payers.isPlaceholderData ? undefined : total}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function PayerList() {
  return (
    <DesktopOnly>
      <Payers />
    </DesktopOnly>
  );
}
