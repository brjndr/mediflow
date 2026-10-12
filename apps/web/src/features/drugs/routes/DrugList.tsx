import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue, useDrugs } from '../hooks/use-drugs';
import { FORMS, SCHEDULES, TYPES } from '../schemas';
import type { Drug, DrugForm, DrugSchedule, DrugType } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** One of a fixed set of values, or the empty "all" choice. */
const oneOf = <Value extends string>(values: readonly Value[], text: string): Value | '' =>
  values.find((value) => value === text) ?? '';

function Catalog() {
  const { t } = useTranslation('drugs');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [search, setSearch] = useState('');
  const [type, setType] = useState<DrugType | ''>('');
  const [form, setForm] = useState<DrugForm | ''>('');
  const [schedule, setSchedule] = useState<DrugSchedule | ''>('');
  const [controlled, setControlled] = useState(false);
  const [archived, setArchived] = useState(false);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const drugs = useDrugs({ q, type, form, schedule, controlled, archived });

  const rows = useMemo(() => drugs.data?.pages.flatMap((page) => page.items) ?? [], [drugs.data]);
  const total = drugs.data?.pages[0]?.total;
  const filtered = q.trim() !== '' || type !== '' || form !== '' || schedule !== '' || controlled;

  const columns = useMemo<GridColumn<Drug>[]>(
    () => [
      {
        id: 'genericName',
        header: t('columns.genericName'),
        value: (row) => row.genericName,
        hideable: false,
        render: (row, text) => (
          <Link to={`/drugs/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'brandName', header: t('columns.brandName'), value: (row) => row.brandName },
      { id: 'form', header: t('columns.form'), value: (row) => t(`forms.${row.form}`) },
      { id: 'strength', header: t('columns.strength'), value: (row) => row.strength },
      {
        id: 'schedule',
        header: t('columns.schedule'),
        value: (row) => t(`schedules.${row.schedule}`),
      },
      {
        id: 'controlled',
        header: t('columns.controlled'),
        value: (row) => t(row.controlled ? 'yes' : 'no'),
      },
      { id: 'type', header: t('columns.type'), value: (row) => t(`types.${row.type}`) },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="drug:manage">
          <Link to="/drugs/new" className={`${link} pt-2 text-sm underline`}>
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
          {t('filters.type')}
          <select
            value={type}
            onChange={(event) => setType(oneOf(TYPES, event.target.value))}
            className={control}
          >
            <option value="">{t('filters.allTypes')}</option>
            {TYPES.map((value) => (
              <option key={value} value={value}>
                {t(`types.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('filters.form')}
          <select
            value={form}
            onChange={(event) => setForm(oneOf(FORMS, event.target.value))}
            className={control}
          >
            <option value="">{t('filters.allForms')}</option>
            {FORMS.map((value) => (
              <option key={value} value={value}>
                {t(`forms.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('filters.schedule')}
          <select
            value={schedule}
            onChange={(event) => setSchedule(oneOf(SCHEDULES, event.target.value))}
            className={control}
          >
            <option value="">{t('filters.allSchedules')}</option>
            {SCHEDULES.map((value) => (
              <option key={value} value={value}>
                {t(`schedules.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={controlled}
            onChange={(event) => setControlled(event.target.checked)}
          />
          {t('filters.controlledOnly')}
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
        {total === undefined || drugs.isPlaceholderData
          ? ''
          : t(archived ? 'countArchived' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.genericName}
        status={drugs.isPending ? 'loading' : drugs.isError ? 'error' : 'ready'}
        errorMessage={drugs.isError ? tCommon(errorMessageKey(drugs.error)) : undefined}
        onRetry={() => void drugs.refetch()}
        emptyMessage={filtered ? t('emptySearch') : archived ? t('emptyArchived') : t('empty')}
        hasNextPage={drugs.hasNextPage}
        loadingMore={drugs.isFetchingNextPage}
        onLoadMore={() => void drugs.fetchNextPage()}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function DrugList() {
  return (
    <DesktopOnly>
      <Catalog />
    </DesktopOnly>
  );
}
