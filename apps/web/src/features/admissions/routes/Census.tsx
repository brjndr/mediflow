import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { maskMrn } from '@/shared/utils/mask';
import { useFormatters } from '@/tenancy';
import { LiveStatus } from '../components/LiveStatus';
import { useBedEvents, useWardOptions } from '../hooks/use-board';
import { useAdmittedPatients, useOccupancy } from '../hooks/use-census';
import type { Admission } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function Census() {
  const { t } = useTranslation('admissions');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const mayWards = usePermission('ward:read');
  const wards = useWardOptions(mayWards);
  const [wardId, setWardId] = useState('');
  const events = useBedEvents(true, wardId);
  const live = events === 'live';

  const occupancy = useOccupancy(wardId, live);
  const list = useAdmittedPatients(wardId, live);
  const rows = useMemo(() => list.data?.pages.flatMap((page) => page.items) ?? [], [list.data]);
  const total = list.data?.pages[0]?.total;

  const beds = occupancy.counts.reduce((sum, each) => sum + each.count, 0);
  const occupied = occupancy.counts.find((each) => each.status === 'occupied')?.count ?? 0;
  // A blocked bed is out of use, so it leaves the rate.
  const blocked = occupancy.counts.find((each) => each.status === 'blocked')?.count ?? 0;
  const usable = beds - blocked;
  const percent = usable > 0 ? Math.round((occupied / usable) * 100) : 0;

  const columns = useMemo<GridColumn<Admission>[]>(
    () => [
      {
        id: 'patient',
        header: t('columns.patient'),
        value: (row) => row.patientName,
        hideable: false,
      },
      { id: 'mrn', header: t('columns.mrn'), value: (row) => row.patientMrn, mask: maskMrn },
      { id: 'ward', header: t('columns.ward'), value: (row) => row.bed?.wardName ?? t('noBed') },
      { id: 'bed', header: t('columns.bed'), value: (row) => row.bed?.bedNumber ?? t('noBed') },
      { id: 'doctor', header: t('columns.doctor'), value: (row) => row.doctorName },
      {
        id: 'admittedAt',
        header: t('columns.admittedAt'),
        value: (row) => format.dateTime(row.admittedAt),
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('census.heading')}</h1>
          <p className="text-muted-foreground">{t('census.description')}</p>
          <LiveStatus status={events} />
        </div>
        <Button asChild variant="outline">
          <Link to="/beds">{t('census.boardLink')}</Link>
        </Button>
      </div>

      {mayWards && wards.isSuccess && (
        <label className="flex min-w-52 max-w-xs flex-col gap-1 text-sm font-medium">
          {t('filters.ward')}
          <select
            value={wardId}
            onChange={(event) => setWardId(event.target.value)}
            className={control}
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

      <section aria-labelledby="occupancy-heading" className="flex flex-col gap-2">
        <h2 id="occupancy-heading" className="text-lg font-semibold">
          {t('census.occupancy')}
        </h2>
        {occupancy.isError ? (
          <div role="alert" className="flex flex-wrap items-center gap-2 text-sm text-destructive">
            {tCommon(errorMessageKey(occupancy.error))}
            <Button type="button" variant="outline" onClick={occupancy.refetch}>
              {t('census.retry')}
            </Button>
          </div>
        ) : occupancy.isPending ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t('census.loading')}
          </p>
        ) : (
          <>
            <p className="text-2xl font-semibold">
              {t('census.rate', { occupied, usable, percent })}
            </p>
            <dl className="grid grid-cols-2 gap-2 md:grid-cols-4">
              {occupancy.counts.map(({ status, count }) => (
                <div key={status} className="rounded-md border p-3">
                  <dt className="text-sm text-muted-foreground">{t(`status.${status}`)}</dt>
                  <dd className="text-xl font-semibold">{count}</dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>

      <DataGrid
        label={t('census.grid')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => t('admissionRowLabel', { patient: row.patientName })}
        status={list.isPending ? 'loading' : list.isError ? 'error' : 'ready'}
        errorMessage={list.isError ? tCommon(errorMessageKey(list.error)) : undefined}
        onRetry={() => void list.refetch()}
        emptyMessage={t('census.empty')}
        hasNextPage={list.hasNextPage && !list.isPlaceholderData}
        total={list.isPlaceholderData ? undefined : total}
        loadingMore={list.isFetchingNextPage}
        onLoadMore={() => void list.fetchNextPage()}
      />
    </div>
  );
}
