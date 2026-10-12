import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { DesktopOnly } from '@/shared/ui/desktop-only';
import { SEARCH_DEBOUNCE_MS, useDebouncedValue, useLabTests } from '../hooks/use-lab-tests';
import { DEPARTMENTS, KINDS } from '../schemas';
import type { LabDepartment, LabTest, LabTestKind } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** One of a fixed set of values, or the empty "all" choice. */
const oneOf = <Value extends string>(values: readonly Value[], text: string): Value | '' =>
  values.find((value) => value === text) ?? '';

function Catalog() {
  const { t } = useTranslation('lab_tests');
  // Error messages come from the API client and live in core `common`.
  const { t: tCommon } = useTranslation();
  const [search, setSearch] = useState('');
  const [department, setDepartment] = useState<LabDepartment | ''>('');
  const [kind, setKind] = useState<LabTestKind | ''>('');
  const [archived, setArchived] = useState(false);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const tests = useLabTests({ q, department, kind, archived });

  const rows = useMemo(() => tests.data?.pages.flatMap((page) => page.items) ?? [], [tests.data]);
  const total = tests.data?.pages[0]?.total;
  const filtered = q.trim() !== '' || department !== '' || kind !== '';

  const columns = useMemo<GridColumn<LabTest>[]>(
    () => [
      {
        id: 'name',
        header: t('columns.name'),
        value: (row) => row.name,
        hideable: false,
        render: (row, text) => (
          <Link to={`/lab-tests/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      { id: 'code', header: t('columns.code'), value: (row) => row.code },
      {
        id: 'department',
        header: t('columns.department'),
        value: (row) => t(`departments.${row.department}`),
      },
      { id: 'kind', header: t('columns.kind'), value: (row) => t(`kinds.${row.kind}`) },
      {
        id: 'sample',
        header: t('columns.sample'),
        value: (row) =>
          [t(`sampleTypes.${row.sampleType}`), row.container].filter(Boolean).join(' · '),
      },
      {
        id: 'turnaround',
        header: t('columns.turnaround'),
        value: (row) => t('hours', { count: row.turnaroundHours }),
      },
      { id: 'unit', header: t('columns.unit'), value: (row) => row.unit ?? '' },
      { id: 'service', header: t('columns.service'), value: (row) => row.serviceName ?? '' },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="labTest:manage">
          <Link to="/lab-tests/new" className={`${link} pt-2 text-sm underline`}>
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
          {t('filters.department')}
          <select
            value={department}
            onChange={(event) => setDepartment(oneOf(DEPARTMENTS, event.target.value))}
            className={control}
          >
            <option value="">{t('filters.allDepartments')}</option>
            {DEPARTMENTS.map((value) => (
              <option key={value} value={value}>
                {t(`departments.${value}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('filters.kind')}
          <select
            value={kind}
            onChange={(event) => setKind(oneOf(KINDS, event.target.value))}
            className={control}
          >
            <option value="">{t('filters.allKinds')}</option>
            {KINDS.map((value) => (
              <option key={value} value={value}>
                {t(`kinds.${value}`)}
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
        {total === undefined || tests.isPlaceholderData
          ? ''
          : t(archived ? 'countArchived' : 'count', { count: total })}
      </p>

      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={tests.isPending ? 'loading' : tests.isError ? 'error' : 'ready'}
        errorMessage={tests.isError ? tCommon(errorMessageKey(tests.error)) : undefined}
        onRetry={() => void tests.refetch()}
        emptyMessage={filtered ? t('emptySearch') : archived ? t('emptyArchived') : t('empty')}
        hasNextPage={tests.hasNextPage}
        loadingMore={tests.isFetchingNextPage}
        onLoadMore={() => void tests.fetchNextPage()}
      />
    </div>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function LabTestList() {
  return (
    <DesktopOnly>
      <Catalog />
    </DesktopOnly>
  );
}
