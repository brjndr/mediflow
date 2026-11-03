import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { REGISTER_PAGE_SIZES, useRegisterSessions } from '../hooks/use-billing';
import { differenceText } from '../lib/register';
import type { RegisterSession } from '../types';

/**
 * Every cash register session of the hospital (`billing/register/sessions`, #118), for
 * `cashRegister:read`: newest first, with what each expected, what was counted and the
 * difference. One server page at a time. An open session has no count yet.
 */
export default function RegisterSessions() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [limit, setLimit] = useState<number>(REGISTER_PAGE_SIZES[0]);
  const sessions = useRegisterSessions(limit);
  const rows = useMemo(
    () => sessions.data?.pages.flatMap((page) => page.items) ?? [],
    [sessions.data],
  );
  const total = sessions.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<RegisterSession>[]>(
    () => [
      {
        id: 'cashier',
        header: t('register.sessions.columns.cashier'),
        value: (row) => row.openedByName,
        hideable: false,
        render: (row, text) => (
          <Link
            to={`/billing/register/sessions/${row.id}`}
            className="inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
          >
            {text}
          </Link>
        ),
      },
      {
        id: 'opened',
        header: t('register.sessions.columns.opened'),
        value: (row) => format.dateTime(row.openedAt),
      },
      {
        id: 'closed',
        header: t('register.sessions.columns.closed'),
        value: (row) =>
          row.closedAt ? format.dateTime(row.closedAt) : t('register.sessions.open'),
      },
      {
        id: 'expected',
        header: t('register.sessions.columns.expected'),
        value: (row) => format.money(row.expectedMinor),
        align: 'end',
      },
      {
        id: 'counted',
        header: t('register.sessions.columns.counted'),
        value: (row) => (row.countedMinor === undefined ? '' : format.money(row.countedMinor)),
        align: 'end',
      },
      {
        id: 'difference',
        header: t('register.sessions.columns.difference'),
        value: (row) =>
          row.differenceMinor === undefined
            ? ''
            : differenceText(row.differenceMinor, t, format.money),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('register.sessions.heading')}</h1>
        <p className="text-muted-foreground">{t('register.sessions.description')}</p>
      </div>
      <label className="flex w-fit flex-col gap-1 text-sm font-medium">
        {t('register.sessions.pageSize')}
        <select
          value={limit}
          onChange={(event) => setLimit(Number(event.target.value))}
          className="h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11"
        >
          {REGISTER_PAGE_SIZES.map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined
          ? t('register.sessions.loaded', { count: rows.length })
          : t('register.sessions.count', { count: total })}
      </p>
      <DataGrid
        label={t('register.sessions.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.openedByName}
        status={sessions.isPending ? 'loading' : sessions.isError ? 'error' : 'ready'}
        errorMessage={sessions.isError ? tCommon(errorMessageKey(sessions.error)) : undefined}
        onRetry={() => void sessions.refetch()}
        emptyMessage={t('register.sessions.empty')}
        hasNextPage={sessions.hasNextPage}
        total={total}
        loadingMore={sessions.isFetchingNextPage}
        onLoadMore={() => void sessions.fetchNextPage()}
      />
    </div>
  );
}
