import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { useFormatters } from '@/tenancy';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue, useServices } from '../hooks/use-services';
import { CATEGORIES } from '../schemas';
import type { Service, ServiceCategory } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

function Catalog() {
  const { t } = useTranslation('services');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<ServiceCategory | ''>('');
  const [archived, setArchived] = useState(false);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const services = useServices({ q, category, archived });

  const rows = useMemo(
    () => services.data?.pages.flatMap((page) => page.items) ?? [],
    [services.data],
  );
  const total = services.data?.pages[0]?.total;
  const filtered = q.trim() !== '' || category !== '';

  const columns = useMemo<GridColumn<Service>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => row.name,
        hideable: false,
        render: (row, text) => (
          <Link to={`/services/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'code', header: t('columns.code'), value: (row) => row.code },
      {
        id: 'category',
        header: t('columns.category'),
        value: (row) => t(`categories.${row.category}`),
      },
      {
        id: 'taxClass',
        header: t('columns.taxClass'),
        value: (row) => t(`taxClasses.${row.taxClass}`),
      },
      {
        id: 'price',
        header: t('columns.price'),
        value: (row) =>
          row.currentPrice ? format.money(row.currentPrice.amountMinor) : t('noPrice'),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="service:manage">
          <Link to="/services/new" className={`${link} pt-2 text-sm underline`}>
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
        <label className="flex min-w-44 flex-col gap-1 text-sm font-medium">
          {t('filters.category')}
          <select
            value={category}
            onChange={(event) =>
              setCategory(CATEGORIES.find((value) => value === event.target.value) ?? '')
            }
            className={control}
          >
            <option value="">{t('filters.allCategories')}</option>
            {CATEGORIES.map((value) => (
              <option key={value} value={value}>
                {t(`categories.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-sm font-medium">
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
        {total === undefined || services.isPlaceholderData
          ? ''
          : t(archived ? 'countArchived' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={services.isPending ? 'loading' : services.isError ? 'error' : 'ready'}
        errorMessage={services.isError ? tCommon(errorMessageKey(services.error)) : undefined}
        onRetry={() => void services.refetch()}
        emptyMessage={filtered ? t('emptySearch') : archived ? t('emptyArchived') : t('empty')}
        hasNextPage={services.hasNextPage}
        loadingMore={services.isFetchingNextPage}
        onLoadMore={() => void services.fetchNextPage()}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ServiceList() {
  return (
    <DesktopOnly>
      <Catalog />
    </DesktopOnly>
  );
}
