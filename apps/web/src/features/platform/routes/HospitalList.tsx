import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useHospitals } from '../hooks/use-hospitals';
import type { Hospital, HospitalStatus } from '../types';

const STATUSES: HospitalStatus[] = ['active', 'suspended', 'offboarding'];

// Default export: route modules are loaded with a dynamic import.
export default function HospitalList() {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  // Said once: read from the history entry the wizard left, then taken out of it, so a reload
  // or a step back does not say it again.
  const [created] = useState(() => (location.state as { created?: string } | null)?.created);
  const [status, setStatus] = useState<HospitalStatus | ''>('');
  const hospitals = useHospitals({ status: status || undefined });
  const statusLine = useRef<HTMLParagraphElement>(null);

  const rows = useMemo(
    () => hospitals.data?.pages.flatMap((page) => page.items) ?? [],
    [hospitals.data],
  );
  const total = hospitals.data?.pages[0]?.total;

  // Arriving from the wizard, the keyboard goes to the line that says the hospital was created.
  useEffect(() => {
    if (created) {
      statusLine.current?.focus();
      void navigate(location.pathname, { replace: true, state: null });
    } else focusIfLost(statusLine.current);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const columns = useMemo<GridColumn<Hospital>[]>(
    () => [
      {
        id: 'name',
        header: t('platform.hospitals.columns.name'),
        value: (row) => row.name,
        render: (row, text) => (
          <Link
            to={`/platform/hospitals/${row.id}`}
            className="rounded-sm font-medium underline outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            {text}
          </Link>
        ),
        hideable: false,
      },
      { id: 'slug', header: t('platform.hospitals.columns.slug'), value: (row) => row.slug },
      {
        id: 'status',
        header: t('platform.hospitals.columns.status'),
        value: (row) => t(`platform.hospitals.status.${row.status}`),
      },
      {
        id: 'members',
        header: t('platform.hospitals.columns.members'),
        value: (row) => row.memberCount,
        align: 'end',
      },
      {
        id: 'region',
        header: t('platform.hospitals.columns.region'),
        value: (row) =>
          row.region ? t(`platform.regions.${row.region}`, { defaultValue: row.region }) : '',
      },
    ],
    [t],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('platform.hospitals.title')}</h1>
          <p className="text-muted-foreground">{t('platform.hospitals.description')}</p>
        </div>
        <Link
          to="/platform/hospitals/new"
          className="inline-flex h-9 items-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:h-11"
        >
          {t('platform.hospitals.add')}
        </Link>
      </div>

      <label className="flex max-w-xs flex-col gap-1 text-sm font-medium">
        {t('platform.hospitals.filter')}
        <select
          className="h-9 rounded-md border bg-background px-3 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 md:text-sm pointer-coarse:h-11"
          value={status}
          onChange={(event) => setStatus(event.target.value as HospitalStatus | '')}
        >
          <option value="">{t('platform.hospitals.allStatuses')}</option>
          {STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(`platform.hospitals.status.${value}`)}
            </option>
          ))}
        </select>
      </label>

      <p
        ref={statusLine}
        tabIndex={-1}
        role="status"
        className="rounded-sm text-sm text-muted-foreground outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {created
          ? t('platform.hospitals.created', { name: created })
          : total === undefined
            ? ''
            : t('platform.hospitals.count', { count: total })}
      </p>

      <DataGrid
        label={t('platform.hospitals.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={hospitals.isPending ? 'loading' : hospitals.isError ? 'error' : 'ready'}
        errorMessage={hospitals.isError ? t(errorMessageKey(hospitals.error)) : undefined}
        onRetry={() => void hospitals.refetch()}
        emptyMessage={t('platform.hospitals.empty')}
        total={total}
        hasNextPage={hospitals.hasNextPage}
        loadingMore={hospitals.isFetchingNextPage}
        onLoadMore={() => void hospitals.fetchNextPage()}
      />
    </div>
  );
}
