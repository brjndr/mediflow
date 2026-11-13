import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useCreditAccounts } from '../hooks/use-credit';
import type { CreditAccount } from '../types';

const link =
  'inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';

/** The corporates billed on credit, with what each owes. The figures are the server's. */
export default function CreditAccountList() {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const accounts = useCreditAccounts();
  const rows = useMemo(
    () => accounts.data?.pages.flatMap((page) => page.items) ?? [],
    [accounts.data],
  );
  const total = accounts.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<CreditAccount>[]>(
    () => [
      {
        id: 'payer',
        header: t('credit.columns.corporate'),
        value: (row) => row.payerName,
        hideable: false,
        render: (row, text) => (
          <Link to={`/credit/${row.payerId}`} className={link}>
            {text}
          </Link>
        ),
      },
      {
        id: 'limit',
        header: t('credit.columns.limit'),
        value: (row) => format.money(row.creditLimitMinor),
        align: 'end',
      },
      {
        id: 'outstanding',
        header: t('credit.columns.outstanding'),
        value: (row) => format.money(row.outstandingMinor),
        align: 'end',
      },
      {
        id: 'overdue',
        header: t('credit.columns.overdue'),
        value: (row) => format.money(row.overdueMinor),
        align: 'end',
      },
      {
        id: 'available',
        header: t('credit.columns.available'),
        value: (row) => format.money(row.availableMinor),
        align: 'end',
      },
      {
        id: 'terms',
        header: t('credit.columns.terms'),
        value: (row) => t('credit.days', { count: row.termsDays }),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('credit.heading')}</h1>
        <p className="text-muted-foreground">{t('credit.description')}</p>
        <Link to="/insurance" className={`${link} text-sm underline`}>
          {t('credit.toPayers')}
        </Link>
      </div>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined ? '' : t('credit.count', { count: total })}
      </p>
      <DataGrid
        label={t('credit.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.payerId}
        rowLabel={(row) => row.payerName}
        status={accounts.isPending ? 'loading' : accounts.isError ? 'error' : 'ready'}
        errorMessage={accounts.isError ? tCommon(errorMessageKey(accounts.error)) : undefined}
        onRetry={() => void accounts.refetch()}
        emptyMessage={t('credit.empty')}
        hasNextPage={accounts.hasNextPage}
        loadingMore={accounts.isFetchingNextPage}
        onLoadMore={() => void accounts.fetchNextPage()}
        total={total}
      />
    </div>
  );
}
