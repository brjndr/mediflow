import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridAction, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { useKitchenList } from '../hooks/use-diet';
import { useWardOptions } from '../hooks/use-nursing';
import type { KitchenListItem } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function KitchenList() {
  const { t } = useTranslation('nursing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const wardId = params.get('ward') ?? '';
  const wards = useWardOptions();
  const list = useKitchenList(wardId);
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<KitchenListItem>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      { id: 'ward', header: t('columns.ward'), value: (row) => row.wardName ?? '' },
      { id: 'bed', header: t('columns.bed'), value: (row) => row.bedNumber ?? t('noBed') },
      {
        id: 'diet',
        header: t('kitchen.columns.diet'),
        // A word when there is none, never an empty cell.
        value: (row) => row.diet?.instructions ?? t('kitchen.noDiet'),
        hideable: false,
      },
      {
        id: 'priority',
        header: t('kitchen.columns.priority'),
        value: (row) => (row.diet ? t(`diet.priority.${row.diet.priority}`) : ''),
      },
      {
        id: 'status',
        header: t('kitchen.columns.status'),
        value: (row) => (row.diet ? t(`diet.status.${row.diet.status}`) : ''),
      },
      {
        id: 'ordered',
        header: t('kitchen.columns.ordered'),
        value: (row) => (row.diet ? format.dateTime(row.diet.placedAt) : ''),
      },
    ],
    [t, format],
  );

  const actions: GridAction<KitchenListItem>[] = [
    {
      id: 'diet',
      label: t('kitchen.open'),
      requires: 'order:read',
      onSelect: (row) => navigate(`/nursing/${row.admissionId}/diet`),
    },
  ];

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <Link to="/nursing" className="text-sm underline underline-offset-2">
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{t('kitchen.heading')}</h1>
        <p className="text-muted-foreground">{t('kitchen.description')}</p>
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
        {total === undefined || list.isPlaceholderData ? '' : t('count', { count: total })}
      </p>
      <DataGrid
        label={t('kitchen.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.admissionId}
        rowLabel={(row) => t('rowLabel', { patient: row.patientName })}
        actions={list.isPlaceholderData ? [] : actions}
        status={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'}
        errorMessage={list.isError ? tCommon(errorMessageKey(list.error)) : undefined}
        onRetry={() => void list.refetch()}
        emptyMessage={t('kitchen.empty')}
        hasNextPage={list.hasNextPage && !list.isPlaceholderData}
        total={list.isPlaceholderData ? undefined : total}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
      />
    </div>
  );
}
