import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn, type GridSort } from '@/shared/ui/data-grid';
import { maskMrn, maskPhone } from '@/shared/utils/mask';
import {
  PATIENT_PAGE_SIZES,
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
  usePatients,
} from '../hooks/use-patients';
import type { PatientSort, PatientSummary } from '../types';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function PatientList() {
  const { t } = useTranslation('patients');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  // Component state only: patient search text never goes in the URL or browser storage.
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<GridSort | null>(null);
  const [limit, setLimit] = useState<number>(PATIENT_PAGE_SIZES[0]);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);

  const sortParam = sort ? (`${sort.desc ? '-' : ''}${sort.id}` as PatientSort) : null;
  const patients = usePatients({ q, sort: sortParam, limit });
  const rows = useMemo(
    () => patients.data?.pages.flatMap((page) => page.items) ?? [],
    [patients.data],
  );
  const total = patients.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<PatientSummary>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => `${row.firstName} ${row.lastName}`,
        sortable: true,
        hideable: false,
      },
      // Masked in lists: the full value is not needed to pick the right row.
      {
        id: 'mrn',
        header: t('columns.mrn'),
        value: (row) => row.mrn,
        mask: maskMrn,
        sortable: true,
      },
      { id: 'phone', header: t('columns.phone'), value: (row) => row.phone, mask: maskPhone },
      { id: 'gender', header: t('columns.gender'), value: (row) => t(`gender.${row.gender}`) },
      { id: 'dob', header: t('columns.dob'), value: (row) => row.dob },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm font-medium">
          {t('search.label')}
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
              placeholder={t('search.placeholder')}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-sm"
            />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('pageSize')}
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="h-9 rounded-md border bg-background px-2 text-sm"
          >
            {PATIENT_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? t('loaded', { count: rows.length }) : t('count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => `${row.firstName} ${row.lastName}`}
        status={patients.isPending ? 'loading' : patients.isError ? 'error' : 'ready'}
        errorMessage={patients.isError ? tCommon(errorMessageKey(patients.error)) : undefined}
        onRetry={() => void patients.refetch()}
        emptyMessage={q.trim() ? t('emptySearch') : t('empty')}
        sort={sort}
        onSortChange={setSort}
        hasNextPage={patients.hasNextPage}
        loadingMore={patients.isFetchingNextPage}
        onLoadMore={() => void patients.fetchNextPage()}
      />
    </div>
  );
}
