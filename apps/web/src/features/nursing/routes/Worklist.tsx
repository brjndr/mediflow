import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Can } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { useStays, useWardOptions } from '../hooks/use-nursing';
import type { StayRow } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Worklist() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const wardId = params.get('ward') ?? '';
  const wards = useWardOptions();
  const stays = useStays(wardId);
  const rows = useMemo(() => stays.data?.pages.flatMap((page) => page.items) ?? [], [stays.data]);
  const total = stays.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<StayRow>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      {
        id: 'bed',
        header: t('columns.bed'),
        value: (row) => row.bed?.bedNumber ?? t('noBed'),
      },
      { id: 'ward', header: t('columns.ward'), value: (row) => row.bed?.wardName ?? '' },
      { id: 'doctor', header: t('columns.doctor'), value: (row) => row.doctorName },
      {
        id: 'admittedAt',
        header: t('columns.admittedAt'),
        value: (row) => format.dateTime(row.admittedAt),
      },
    ],
    [t, format],
  );

  const actions: GridAction<StayRow>[] = [
    {
      id: 'vitals',
      label: t('actions.vitals'),
      requires: 'nursingVitals:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/vitals`),
    },
    {
      id: 'notes',
      label: t('actions.notes'),
      requires: 'progressNote:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/notes`),
    },
    {
      id: 'fluids',
      label: t('actions.fluids'),
      requires: 'fluidBalance:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/fluids`),
    },
    {
      id: 'care',
      label: t('actions.care'),
      requires: 'carePlan:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/care-plan`),
    },
    {
      id: 'mar',
      label: t('actions.mar'),
      requires: 'mar:read',
      onSelect: (row) => navigate(`/nursing/${row.id}/mar`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('heading')}</h1>
        <p className="text-muted-foreground">{t('description')}</p>
        <Can permission="progressNote:read">
          <Link to="/nursing/rounds" className="text-sm underline underline-offset-2">
            {t('rounds.link')}
          </Link>
        </Can>
      </div>

      {wards.data && (
        <label className="flex min-w-52 flex-col gap-1 text-sm font-medium">
          {t('filters.ward')}
          <select
            value={wardId}
            onChange={(event) => setParams(event.target.value ? { ward: event.target.value } : {})}
            className={`${control} max-w-xs`}
          >
            <option value="">{t('filters.allWards')}</option>
            {wards.data.map((ward) => (
              <option key={ward.id} value={ward.id}>
                {ward.name}
              </option>
            ))}
          </select>
        </label>
      )}

      <p className="text-sm text-muted-foreground">
        {total === undefined || stays.isPlaceholderData ? '' : t('count', { count: total })}
      </p>
      <DataGrid
        label={t('gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('rowLabel', { patient: row.patientName })}
        actions={stays.isPlaceholderData ? [] : actions}
        status={stays.isPending ? 'loading' : stays.isError ? 'error' : 'ready'}
        errorMessage={stays.isError ? tCommon(errorMessageKey(stays.error)) : undefined}
        onRetry={() => void stays.refetch()}
        emptyMessage={t('empty')}
        hasNextPage={stays.hasNextPage && !stays.isPlaceholderData}
        total={stays.isPlaceholderData ? undefined : total}
        loadingMore={stays.isFetchingNextPage}
        onLoadMore={() => void stays.fetchNextPage()}
      />
    </div>
  );
}
