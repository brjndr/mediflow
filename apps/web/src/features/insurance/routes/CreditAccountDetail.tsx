import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useParams } from 'react-router-dom';
import { usePermission } from '@/access';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { PageSkeleton } from '@/shared/ui/page-skeleton';
import { PrintSheet } from '@/shared/ui/print-sheet';
import { StatusBadge } from '@/shared/ui/status-badge';
import { SystemPage } from '@/shared/ui/system-page';
import { useFormatters, useTenant } from '@/tenancy';
import { CreditTermsDialog } from '../components/CreditTermsDialog';
import { PrintAction, ReceiptDocument, StatementDocument } from '../components/CreditPrint';
import { ReceiptDialog } from '../components/ReceiptDialog';
import {
  accountReconciles,
  BILL_STATUSES,
  daysBefore,
  statementReconciles,
  todayAt,
} from '../credit';
import { useCreditAccount, useCreditBills, useReceipts, useStatement } from '../hooks/use-credit';
import type { CreditAccount, CreditBill, CreditBillStatus, Receipt, StatementLine } from '../types';

const link =
  'inline-flex items-center rounded-sm text-sm font-medium underline underline-offset-4 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-11';
const control = 'h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATEMENT_DAYS = 90;

function Summary({ account }: { account: CreditAccount }) {
  const { t } = useTranslation('insurance');
  const format = useFormatters();
  const adds = accountReconciles(account);
  const items: [string, number, string][] = [
    ['limit', account.creditLimitMinor, 'credit-limit'],
    ['billed', account.billedMinor, 'credit-billed'],
    ['received', account.receivedMinor, 'credit-received'],
    ['outstanding', account.outstandingMinor, 'credit-outstanding'],
    ['overdue', account.overdueMinor, 'credit-overdue'],
    ['available', account.availableMinor, 'credit-available'],
  ];
  return (
    <section aria-labelledby="credit-summary" className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id="credit-summary" className="text-lg font-semibold">
        {t('credit.summary.heading')}
      </h2>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm md:grid-cols-3">
        {items.map(([key, value, testId]) => (
          <div key={key} className="flex flex-col">
            <dt className="text-muted-foreground">{t(`credit.summary.${key}`)}</dt>
            <dd className="text-base font-medium tabular-nums" data-testid={testId}>
              {format.money(value)}
            </dd>
          </div>
        ))}
        <div className="flex flex-col">
          <dt className="text-muted-foreground">{t('credit.summary.terms')}</dt>
          <dd className="text-base font-medium">
            {t('credit.days', { count: account.termsDays })}
          </dd>
        </div>
      </dl>
      <div>
        <StatusBadge
          tone={adds ? 'success' : 'danger'}
          label={adds ? t('credit.summary.reconciled') : t('credit.summary.notReconciled')}
        />
      </div>
    </section>
  );
}

function BillsSection({ payerId }: { payerId: string }) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const [status, setStatus] = useState<CreditBillStatus | ''>('');
  const bills = useCreditBills(payerId, status);
  const rows = useMemo(() => bills.data?.pages.flatMap((page) => page.items) ?? [], [bills.data]);
  const total = bills.data?.pages[0]?.total;
  const columns = useMemo<GridColumn<CreditBill>[]>(
    () => [
      {
        id: 'number',
        header: t('credit.columns.number'),
        value: (row) => row.number,
        hideable: false,
      },
      {
        id: 'issued',
        header: t('credit.columns.issued'),
        value: (row) => format.calendarDate(row.issuedOn),
      },
      {
        id: 'due',
        header: t('credit.columns.due'),
        value: (row) => format.calendarDate(row.dueOn),
      },
      {
        id: 'amount',
        header: t('credit.columns.amount'),
        value: (row) => format.money(row.amountMinor),
        align: 'end',
      },
      {
        id: 'received',
        header: t('credit.columns.received'),
        value: (row) => format.money(row.receivedMinor),
        align: 'end',
      },
      {
        id: 'outstanding',
        header: t('credit.columns.outstanding'),
        value: (row) => format.money(row.outstandingMinor),
        align: 'end',
      },
      {
        id: 'status',
        header: t('credit.columns.status'),
        value: (row) =>
          row.overdue ? t('credit.status.overdue') : t(`credit.status.${row.status}`),
        render: (row, text) => (
          <StatusBadge
            tone={row.overdue ? 'danger' : row.status === 'paid' ? 'success' : 'info'}
            label={text}
          />
        ),
      },
    ],
    [t, format],
  );
  return (
    <section aria-labelledby="credit-bills" className="flex flex-col gap-3">
      <h2 id="credit-bills" className="text-lg font-semibold">
        {t('credit.bills.heading')}
      </h2>
      <label className="flex flex-col gap-1 text-sm font-medium self-start">
        {t('credit.bills.filter')}
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as CreditBillStatus | '')}
          className={control}
        >
          <option value="">{t('credit.bills.any')}</option>
          {BILL_STATUSES.map((value) => (
            <option key={value} value={value}>
              {t(`credit.status.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <DataGrid
        label={t('credit.bills.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.number}
        status={bills.isPending ? 'loading' : bills.isError ? 'error' : 'ready'}
        errorMessage={bills.isError ? tCommon(errorMessageKey(bills.error)) : undefined}
        onRetry={() => void bills.refetch()}
        emptyMessage={t('credit.bills.empty')}
        hasNextPage={bills.hasNextPage}
        loadingMore={bills.isFetchingNextPage}
        onLoadMore={() => void bills.fetchNextPage()}
        total={bills.isPlaceholderData ? undefined : total}
      />
    </section>
  );
}

function ReceiptsSection({ payerId }: { payerId: string }) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const receipts = useReceipts(payerId);
  const rows = useMemo(
    () => receipts.data?.pages.flatMap((page) => page.items) ?? [],
    [receipts.data],
  );
  const columns = useMemo<GridColumn<Receipt>[]>(
    () => [
      {
        id: 'number',
        header: t('credit.columns.number'),
        value: (row) => row.number,
        hideable: false,
      },
      {
        id: 'date',
        header: t('credit.columns.date'),
        value: (row) => format.calendarDate(row.receivedOn),
      },
      {
        id: 'method',
        header: t('credit.receipt.method'),
        value: (row) => t(`credit.method.${row.method}`),
      },
      {
        id: 'reference',
        header: t('credit.receipt.reference'),
        value: (row) => row.reference ?? '',
      },
      {
        id: 'amount',
        header: t('credit.columns.amount'),
        value: (row) => format.money(row.amountMinor),
        align: 'end',
      },
      {
        id: 'print',
        header: t('credit.columns.print'),
        value: () => '',
        render: (row) => (
          <PrintAction size="sm" label={t('credit.receipt.printNumber', { number: row.number })}>
            <ReceiptDocument receipt={row} />
          </PrintAction>
        ),
      },
    ],
    [t, format],
  );
  return (
    <section aria-labelledby="credit-receipts" className="flex flex-col gap-3">
      <h2 id="credit-receipts" className="text-lg font-semibold">
        {t('credit.receipts.heading')}
      </h2>
      <DataGrid
        label={t('credit.receipts.heading')}
        columns={columns}
        rows={rows}
        rowId={(row) => row.id}
        rowLabel={(row) => row.number}
        status={receipts.isPending ? 'loading' : receipts.isError ? 'error' : 'ready'}
        errorMessage={receipts.isError ? tCommon(errorMessageKey(receipts.error)) : undefined}
        onRetry={() => void receipts.refetch()}
        emptyMessage={t('credit.receipts.empty')}
        hasNextPage={receipts.hasNextPage}
        loadingMore={receipts.isFetchingNextPage}
        onLoadMore={() => void receipts.fetchNextPage()}
      />
    </section>
  );
}

function StatementSection({ account }: { account: CreditAccount }) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const today = todayAt(useTenant()?.timezone);
  const [from, setFrom] = useState(() => daysBefore(today, STATEMENT_DAYS));
  const [to, setTo] = useState(today);
  const valid = DATE.test(from) && DATE.test(to) && from <= to;
  const statement = useStatement(account.payerId, from, to, valid);
  const lines = useMemo(
    () => statement.data?.pages.flatMap((page) => page.items) ?? [],
    [statement.data],
  );
  // The totals are the same on every page: the first has them.
  const head = statement.data?.pages[0];
  const [printing, setPrinting] = useState<StatementLine[] | null>(null);
  const [loadingAll, setLoadingAll] = useState(false);

  const columns = useMemo<GridColumn<StatementLine>[]>(
    () => [
      {
        id: 'number',
        header: t('credit.columns.number'),
        value: (row) => row.number,
        hideable: false,
      },
      { id: 'date', header: t('credit.columns.date'), value: (row) => format.calendarDate(row.on) },
      {
        id: 'billed',
        header: t('credit.columns.billed'),
        value: (row) => (row.debitMinor > 0 ? format.money(row.debitMinor) : ''),
        align: 'end',
      },
      {
        id: 'received',
        header: t('credit.columns.received'),
        value: (row) => (row.creditMinor > 0 ? format.money(row.creditMinor) : ''),
        align: 'end',
      },
      {
        id: 'balance',
        header: t('credit.columns.balance'),
        value: (row) => format.money(row.balanceMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  // Every page is needed on paper, so a long statement is read to its end before printing.
  const printAll = async () => {
    setLoadingAll(true);
    try {
      let result = { hasNextPage: statement.hasNextPage, data: statement.data };
      while (result.hasNextPage) {
        const next = await statement.fetchNextPage();
        result = { hasNextPage: next.hasNextPage, data: next.data };
      }
      setPrinting(result.data?.pages.flatMap((page) => page.items) ?? lines);
    } finally {
      setLoadingAll(false);
    }
  };

  const upToDate = to >= today;
  const adds = head ? statementReconciles(head, account, upToDate) : true;

  return (
    <section aria-labelledby="credit-statement" className="flex flex-col gap-3">
      <h2 id="credit-statement" className="text-lg font-semibold">
        {t('credit.statement.heading')}
      </h2>
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('credit.statement.from')}
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.target.value)}
            className={control}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('credit.statement.to')}
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.target.value)}
            className={control}
          />
        </label>
        <Button
          type="button"
          variant="outline"
          aria-disabled={!head || loadingAll || undefined}
          onClick={() => {
            if (head && !loadingAll) void printAll();
          }}
        >
          {loadingAll ? t('credit.statement.preparing') : t('credit.statement.print')}
        </Button>
      </div>
      {!valid && (
        <p role="alert" className="text-sm text-destructive">
          {t('credit.statement.badPeriod')}
        </p>
      )}
      {head && (
        <>
          <dl
            className="grid grid-cols-2 gap-x-6 gap-y-1 text-sm md:grid-cols-4"
            aria-label={t('credit.statement.totals')}
          >
            <div>
              <dt className="text-muted-foreground">{t('credit.statement.opening')}</dt>
              <dd className="font-medium tabular-nums" data-testid="statement-opening">
                {format.money(head.openingMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('credit.columns.billed')}</dt>
              <dd className="font-medium tabular-nums" data-testid="statement-billed">
                {format.money(head.billedMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('credit.columns.received')}</dt>
              <dd className="font-medium tabular-nums" data-testid="statement-received">
                {format.money(head.receivedMinor)}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('credit.statement.closing')}</dt>
              <dd className="font-medium tabular-nums" data-testid="statement-closing">
                {format.money(head.closingMinor)}
              </dd>
            </div>
          </dl>
          <div>
            <StatusBadge
              tone={adds ? 'success' : 'danger'}
              label={adds ? t('credit.statement.reconciled') : t('credit.statement.notReconciled')}
            />
          </div>
        </>
      )}
      <DataGrid
        label={t('credit.statement.heading')}
        columns={columns}
        rows={lines}
        rowId={(row) => row.id}
        rowLabel={(row) => row.number}
        status={statement.isPending && valid ? 'loading' : statement.isError ? 'error' : 'ready'}
        errorMessage={statement.isError ? tCommon(errorMessageKey(statement.error)) : undefined}
        onRetry={() => void statement.refetch()}
        emptyMessage={t('credit.statement.empty')}
        hasNextPage={statement.hasNextPage}
        loadingMore={statement.isFetchingNextPage}
        onLoadMore={() => void statement.fetchNextPage()}
      />
      {printing && head && (
        <PrintSheet onDone={() => setPrinting(null)}>
          <StatementDocument statement={head} lines={printing} />
        </PrintSheet>
      )}
    </section>
  );
}

// Default export: route modules are loaded by the manifest with a dynamic import.
export default function CreditAccountDetail() {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const params = useParams();
  const payerId = params.payerId !== undefined && ID.test(params.payerId) ? params.payerId : '';
  const account = useCreditAccount(payerId);
  const canManage = usePermission('receivable:manage');
  const canReceipt = usePermission('receivable:receipt');
  const [terms, setTerms] = useState(false);
  const [receipt, setReceipt] = useState(false);
  const [done, setDone] = useState('');
  const status = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (done) focusIfLost(status.current);
  }, [done]);

  if (account.isPending && payerId !== '') {
    return <PageSkeleton label={t('credit.detail.loading')} />;
  }
  const none =
    payerId !== '' && isApiError(account.error) && account.error.status === 404 && !account.data;
  if (none) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-4 py-6">
        <h1 className="text-2xl font-semibold tracking-tight">{t('credit.detail.noAccount')}</h1>
        <p className="text-muted-foreground">{t('credit.detail.noAccountBody')}</p>
        <div className="flex flex-wrap items-center gap-3">
          {canManage && (
            <Button onClick={() => setTerms(true)}>{t('credit.terms.openTitle')}</Button>
          )}
          <Link to="/credit" className={link}>
            {t('credit.backToList')}
          </Link>
        </div>
        {terms && (
          <CreditTermsDialog
            payerId={payerId}
            onClose={() => setTerms(false)}
            onSaved={() => {
              setTerms(false);
              setDone(t('credit.done.opened'));
            }}
          />
        )}
        <p ref={status} role="status" tabIndex={-1} className={done ? 'text-sm' : 'sr-only'}>
          {done}
        </p>
      </div>
    );
  }
  if (account.data === undefined) {
    const missing = payerId === '';
    return (
      <SystemPage
        alert={!missing}
        title={missing ? t('credit.detail.notFound') : t('notFound.errorTitle')}
        description={
          missing ? t('credit.detail.notFoundBody') : tCommon(errorMessageKey(account.error))
        }
        actions={
          <Link to="/credit" className={link}>
            {t('credit.backToList')}
          </Link>
        }
      />
    );
  }
  const data = account.data;

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('credit.detail.heading', { name: data.payerName })}
        </h1>
        <p className="text-muted-foreground">{t('credit.detail.description')}</p>
        <Link to="/credit" className={link}>
          {t('credit.backToList')}
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {canReceipt && (
          <Button
            type="button"
            aria-disabled={data.outstandingMinor === 0 || undefined}
            onClick={() => {
              if (data.outstandingMinor > 0) setReceipt(true);
            }}
          >
            {t('credit.receipt.button')}
          </Button>
        )}
        {canManage && (
          <Button type="button" variant="outline" onClick={() => setTerms(true)}>
            {t('credit.terms.editTitle')}
          </Button>
        )}
      </div>
      <p ref={status} role="status" tabIndex={-1} className={done ? 'text-sm' : 'sr-only'}>
        {done}
      </p>
      <Summary account={data} />
      <BillsSection payerId={data.payerId} />
      <ReceiptsSection payerId={data.payerId} />
      <StatementSection account={data} />
      {terms && (
        <CreditTermsDialog
          payerId={data.payerId}
          account={data}
          onClose={() => setTerms(false)}
          onSaved={() => {
            setTerms(false);
            setDone(t('credit.done.saved'));
          }}
        />
      )}
      {receipt && <ReceiptDialog account={data} onClose={() => setReceipt(false)} />}
    </div>
  );
}
