import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { ClaimPatient } from '../components/ClaimPatient';
import { ClaimStatusBadge } from '../components/ClaimStatusBadge';
import { CLAIM_STATUSES } from '../claims';
import { useClaims } from '../hooks/use-claims';
import type { Claim, ClaimStatus } from '../types';

const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';
const DAY_MS = 86_400_000;

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function ClaimList() {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [status, setStatus] = useState<ClaimStatus | ''>('');
  const claims = useClaims(status);
  const rows = useMemo(() => claims.data?.pages.flatMap((page) => page.items) ?? [], [claims.data]);
  const total = claims.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Claim>[]>(
    () => [
      {
        id: 'number',
        header: t('claims.columns.number'),
        value: (row) => row.number,
        hideable: false,
        render: (row, text) => (
          <Link to={`/claims/${row.id}`} className={link}>
            {text}
          </Link>
        ),
      },
      {
        id: 'patient',
        header: t('claims.columns.patient'),
        value: () => '',
        render: (row) => <ClaimPatient patientId={row.patientId} />,
      },
      { id: 'payer', header: t('claims.columns.payer'), value: (row) => row.payerName },
      {
        id: 'claimed',
        header: t('claims.columns.claimed'),
        value: (row) => format.money(row.claimedMinor),
        align: 'end',
      },
      {
        id: 'outstanding',
        header: t('claims.columns.outstanding'),
        value: (row) => format.money(row.outstandingMinor),
        align: 'end',
      },
      {
        id: 'status',
        header: t('claims.columns.status'),
        value: (row) => t(`claims.status.${row.status}`),
        render: (row) => <ClaimStatusBadge status={row.status} />,
      },
      {
        id: 'age',
        header: t('claims.columns.age'),
        value: (row) =>
          row.submittedAt === undefined
            ? t('claims.notSent')
            : t('claims.days', {
                count: Math.max(Math.floor((Date.now() - Date.parse(row.submittedAt)) / DAY_MS), 0),
              }),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('claims.heading')}</h1>
        <p className="text-muted-foreground">{t('claims.description')}</p>
        <Link to="/claims/aging" className={`${link} pt-2 text-sm underline`}>
          {t('claims.aging')}
        </Link>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('claims.filters.status')}
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value as ClaimStatus | '')}
            className={control}
          >
            <option value="">{t('claims.filters.any')}</option>
            {CLAIM_STATUSES.map((value) => (
              <option key={value} value={value}>
                {t(`claims.status.${value}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined || claims.isPlaceholderData ? '' : t('claims.count', { count: total })}
      </p>

      <DataGrid
        label={t('claims.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.number}
        status={claims.isPending ? 'loading' : claims.isError ? 'error' : 'ready'}
        errorMessage={claims.isError ? tCommon(errorMessageKey(claims.error)) : undefined}
        onRetry={() => void claims.refetch()}
        emptyMessage={status === '' ? t('claims.empty') : t('claims.emptyStatus')}
        hasNextPage={claims.hasNextPage}
        loadingMore={claims.isFetchingNextPage}
        onLoadMore={() => void claims.fetchNextPage()}
        total={claims.isPlaceholderData ? undefined : total}
      />
    </div>
  );
}
