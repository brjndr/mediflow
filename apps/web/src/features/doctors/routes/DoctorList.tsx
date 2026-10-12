import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { useDepartmentOptions } from '@/features/departments';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue, useDoctors } from '../hooks/use-doctors';
import type { Doctor } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function DoctorList() {
  const { t } = useTranslation('doctors');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [search, setSearch] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [inactive, setInactive] = useState(false);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const departments = useDepartmentOptions();
  const doctors = useDoctors({ q, departmentId, active: !inactive });

  const rows = useMemo(
    () => doctors.data?.pages.flatMap((page) => page.items) ?? [],
    [doctors.data],
  );
  const total = doctors.data?.pages[0]?.total;
  const filtered = q.trim() !== '' || departmentId !== '';

  const columns = useMemo<GridColumn<Doctor>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => row.name,
        hideable: false,
        render: (row, text) => (
          <Link to={`/doctors/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'department', header: t('columns.department'), value: (row) => row.departmentName },
      {
        id: 'specialization',
        header: t('columns.specialization'),
        value: (row) => row.specialization,
      },
      {
        id: 'consultation',
        header: t('columns.consultation'),
        value: (row) => t('minutes', { count: row.consultationMinutes }),
      },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="doctor:manage">
          <Link to="/doctors/new" className={`${link} pt-2 text-sm underline`}>
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
        {departments.available && (
          <label className="flex min-w-44 flex-col gap-1 text-sm font-medium">
            {t('filters.department')}
            <select
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
              className={control}
            >
              <option value="">{t('filters.allDepartments')}</option>
              {(departments.data ?? []).map((department) => (
                <option key={department.id} value={department.id}>
                  {department.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="flex items-center gap-2 text-sm font-medium pointer-coarse:min-h-11">
          <input
            type="checkbox"
            className="h-4 w-4"
            checked={inactive}
            onChange={(event) => setInactive(event.target.checked)}
          />
          {t('filters.showInactive')}
        </label>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {/* Not while the previous filter's rows are still shown: the total would be theirs. */}
        {total === undefined || doctors.isPlaceholderData
          ? ''
          : t(inactive ? 'countInactive' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={doctors.isPending ? 'loading' : doctors.isError ? 'error' : 'ready'}
        errorMessage={doctors.isError ? tCommon(errorMessageKey(doctors.error)) : undefined}
        onRetry={() => void doctors.refetch()}
        emptyMessage={filtered ? t('emptySearch') : inactive ? t('emptyInactive') : t('empty')}
        hasNextPage={doctors.hasNextPage}
        loadingMore={doctors.isFetchingNextPage}
        onLoadMore={() => void doctors.fetchNextPage()}
      />
    </div>
  );
}
