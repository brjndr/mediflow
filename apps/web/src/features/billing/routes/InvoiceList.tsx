import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { errorMessageKey } from '@/shared/api';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import {
  INVOICE_PAGE_SIZES,
  SEARCH_DEBOUNCE_MS,
  useDebouncedValue,
  useInvoices,
} from '../hooks/use-billing';
import type { Invoice } from '../types';

const STATUSES: Invoice['status'][] = ['draft', 'issued', 'paid', 'void'];

/**
 * The hospital's invoices (`billing/invoices`, #110), for `invoice:read`: newest first, found by
 * number, patient name or MRN, and by status. One server page at a time. The term is component
 * state: it can name a patient, so it never goes in the address or browser storage.
 */
export default function InvoiceList() {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<Invoice['status'] | null>(null);
  const [limit, setLimit] = useState<number>(INVOICE_PAGE_SIZES[0]);
  const q = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const invoices = useInvoices({ q, status, limit });
  const rows = useMemo(
    () => invoices.data?.pages.flatMap((page) => page.items) ?? [],
    [invoices.data],
  );
  const total = invoices.data?.pages[0]?.total;

  const columns = useMemo<GridColumn<Invoice>[]>(
    () => [
      {
        id: 'number',
        header: t('list.columns.number'),
        value: (row) => row.number ?? t('list.draftNumber'),
        hideable: false,
        render: (row, text) => (
          <Link
            to={`/billing/invoices/${row.id}`}
            className="inline-flex items-center rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11"
          >
            {text}
          </Link>
        ),
      },
      {
        id: 'patient',
        header: t('list.columns.patient'),
        value: (row) => t('new.patient', { name: row.patientName, mrn: row.patientMrn }),
      },
      {
        id: 'date',
        header: t('list.columns.date'),
        value: (row) => format.dateTime(row.issuedAt ?? row.createdAt),
      },
      {
        id: 'total',
        header: t('list.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      {
        id: 'paid',
        header: t('list.columns.paid'),
        value: (row) => format.money(row.paidMinor),
        align: 'end',
      },
      { id: 'status', header: t('list.columns.status'), value: (row) => t(`status.${row.status}`) },
    ],
    [t, format],
  );

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">{t('list.heading')}</h1>
        <p className="text-muted-foreground">{t('list.description')}</p>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <label className="flex min-w-64 flex-1 flex-col gap-1 text-sm font-medium">
          {t('list.search.label')}
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
              placeholder={t('list.search.placeholder')}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-base md:text-sm pointer-coarse:h-11"
            />
          </span>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('list.statusFilter')}
          <select
            value={status ?? ''}
            onChange={(event) =>
              setStatus((event.target.value || null) as Invoice['status'] | null)
            }
            className="h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11"
          >
            <option value="">{t('list.allStatuses')}</option>
            {STATUSES.map((each) => (
              <option key={each} value={each}>
                {t(`status.${each}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('list.pageSize')}
          <select
            value={limit}
            onChange={(event) => setLimit(Number(event.target.value))}
            className="h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11"
          >
            {INVOICE_PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      <p role="status" className="text-sm text-muted-foreground">
        {total === undefined
          ? t('list.loaded', { count: rows.length })
          : t('list.count', { count: total })}
      </p>

      <DataGrid
        label={t('list.gridLabel')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.number ?? t('list.draftNumber')}
        status={invoices.isPending ? 'loading' : invoices.isError ? 'error' : 'ready'}
        errorMessage={invoices.isError ? tCommon(errorMessageKey(invoices.error)) : undefined}
        onRetry={() => void invoices.refetch()}
        emptyMessage={q.trim() || status ? t('list.emptySearch') : t('list.empty')}
        hasNextPage={invoices.hasNextPage}
        total={total}
        loadingMore={invoices.isFetchingNextPage}
        onLoadMore={() => void invoices.fetchNextPage()}
      />
    </div>
  );
}
