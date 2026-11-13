import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useClaimAging } from '../hooks/use-claims';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

interface AgingLine {
  id: string;
  name: string;
  claims: number;
  buckets: number[];
  outstandingMinor: number;
}

/** What the payers still owe, by days since each claim was sent. The figures are the server's. */
export default function ClaimAging() {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const aging = useClaimAging();

  const rows = useMemo<AgingLine[]>(() => {
    if (!aging.data) return [];
    const lines = aging.data.rows.map((row) => ({
      id: row.payerId,
      name: row.payerName,
      claims: row.claims,
      buckets: row.buckets,
      outstandingMinor: row.outstandingMinor,
    }));
    // The total row is last, so it reads as the bottom of the table.
    return lines.length === 0
      ? lines
      : [...lines, { id: 'total', name: t('claims.agingPage.totals'), ...aging.data.totals }];
  }, [aging.data, t]);

  const columns = useMemo<GridColumn<AgingLine>[]>(
    () => [
      {
        id: 'payer',
        header: t('claims.agingPage.payer'),
        value: (row) => row.name,
        hideable: false,
      },
      {
        id: 'claims',
        header: t('claims.agingPage.claims'),
        value: (row) => String(row.claims),
        align: 'end',
      },
      ...([0, 1, 2, 3] as const).map((index) => ({
        id: `bucket${index}`,
        header: t(`claims.agingPage.bucket${index}`),
        value: (row: AgingLine) => format.money(row.buckets[index] ?? 0),
        align: 'end' as const,
      })),
      {
        id: 'total',
        header: t('claims.agingPage.total'),
        value: (row) => format.money(row.outstandingMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('claims.agingPage.heading')}</h1>
        <p className="text-muted-foreground">{t('claims.agingPage.description')}</p>
        <Link to="/claims" className={link}>
          {t('claims.backToList')}
        </Link>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {aging.data ? t('claims.agingPage.asOf', { when: format.dateTime(aging.data.asOf) }) : ''}
      </p>
      <DataGrid
        label={t('claims.agingPage.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.name}
        status={aging.isPending ? 'loading' : aging.isError ? 'error' : 'ready'}
        errorMessage={aging.isError ? tCommon(errorMessageKey(aging.error)) : undefined}
        onRetry={() => void aging.refetch()}
        emptyMessage={t('claims.agingPage.empty')}
      />
    </div>
  );
}
