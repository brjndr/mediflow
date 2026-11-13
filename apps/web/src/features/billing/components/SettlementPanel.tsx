import { CheckCircle2, CircleAlert } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { usePermission } from '@/access';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { useFormatters } from '@/tenancy';
import { useApplyDeposits, useSettlement } from '../hooks/use-stay-bill';
import { refusalText, useFocusWhenFormGoes } from '../lib/panel-helpers';
import type { StaySettlement } from '../stay-bill';
import { DepositRefundForm } from './DepositRefundForm';

type SettlementInvoice = StaySettlement['invoices'][number];

const APPLY_REFUSALS = new Set(['no_deposit_held', 'invoice_not_payable']);

/**
 * The final bill and settlement of an inpatient stay (DS-04, #167), under the running bill:
 * the stay's invoices against the ledger (the invoices must add up to the charges), the deposits
 * held set against an invoice or paid back when they are more than is due, and whether the
 * patient may go home under the hospital's policy. Payments, other modes and credit notes are on
 * each invoice's own page; this screen reads the server's figures and works out nothing.
 */
export function SettlementPanel({
  admissionId,
  encounterId,
}: {
  admissionId: string;
  encounterId: string;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const navigate = useNavigate();
  const found = useSettlement(admissionId);
  const apply = useApplyDeposits(admissionId);
  const canInvoice = usePermission('invoice:create');
  const canPay = usePermission('payment:create');
  const canRefund = usePermission('payment:refund');
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const settlement = found.data;
  const target = settlement?.invoices.find(
    (invoice) =>
      invoice.status === 'issued' &&
      invoice.totalMinor - invoice.creditedMinor - invoice.paidMinor > 0,
  );
  const applying =
    canPay && settlement !== undefined && settlement.depositsHeldMinor > 0 && !!target;
  useFocusWhenFormGoes(applying, message !== null, status);

  const columns = useMemo<GridColumn<SettlementInvoice>[]>(
    () => [
      {
        id: 'number',
        header: t('settlement.columns.invoice'),
        value: (row) => row.number ?? t('settlement.draft'),
      },
      {
        id: 'status',
        header: t('settlement.columns.status'),
        value: (row) => t(`status.${row.status}`),
      },
      {
        id: 'total',
        header: t('settlement.columns.total'),
        value: (row) => format.money(row.totalMinor),
        align: 'end',
      },
      {
        id: 'credited',
        header: t('settlement.columns.credited'),
        value: (row) => format.money(row.creditedMinor),
        align: 'end',
      },
      {
        id: 'paid',
        header: t('settlement.columns.paid'),
        value: (row) => format.money(row.paidMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  async function setAgainst(invoice: SettlementInvoice) {
    setMessage(null);
    try {
      const after = await apply.mutateAsync(invoice.id);
      setMessage({
        text: t('settlement.applied', {
          amount: format.money((settlement?.depositsHeldMinor ?? 0) - after.depositsHeldMinor),
        }),
        failed: false,
      });
    } catch (error) {
      setMessage({
        text: refusalText(error, APPLY_REFUSALS, 'settlement', t, tCommon),
        failed: true,
      });
    }
  }

  return (
    <section aria-labelledby="settlement-heading" className="flex flex-col gap-3">
      <h2 id="settlement-heading" className="text-lg font-semibold">
        {t('settlement.heading')}
      </h2>
      {/* Always on the page, so a deposit set against an invoice or paid back is announced. */}
      <p
        ref={status}
        tabIndex={-1}
        role="status"
        className={cn(
          'text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 empty:hidden',
          message?.failed && 'text-destructive',
        )}
      >
        {message?.text}
      </p>
      {found.isPending ? (
        <p className="text-sm text-muted-foreground">{tCommon('app.loading')}</p>
      ) : found.isError || !settlement ? (
        <div className="flex flex-col items-start gap-2">
          <p role="alert" className="text-sm text-destructive">
            {t('settlement.failed')}
          </p>
          <Button type="button" variant="outline" onClick={() => void found.refetch()}>
            {tCommon('grid.retry')}
          </Button>
        </div>
      ) : (
        <>
          <p className="flex items-center gap-2 text-sm font-medium" data-testid="clearance">
            {settlement.clearance.cleared ? (
              <CheckCircle2 aria-hidden className="size-4" />
            ) : (
              <CircleAlert aria-hidden className="size-4" />
            )}
            {settlement.clearance.cleared
              ? t('settlement.cleared')
              : t('settlement.notCleared', {
                  reasons: settlement.clearance.reasons
                    .map((reason) => t(`settlement.reasons.${reason}`))
                    .join('; '),
                })}
          </p>
          <p className="text-xs text-muted-foreground">
            {t(`settlement.policy.${settlement.policy}`)}
          </p>
          <DataGrid
            label={t('settlement.invoices')}
            columns={columns}
            rows={settlement.invoices}
            rowId={(row) => row.id}
            rowLabel={(row) => row.number ?? t('settlement.draft')}
            status="ready"
            emptyMessage={t('settlement.none')}
            actions={[
              {
                id: 'open',
                label: t('settlement.open'),
                requires: 'invoice:read',
                onSelect: (row) => navigate(`/billing/invoices/${row.id}`),
              },
            ]}
          />
          <dl
            className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm"
            aria-label={t('settlement.totals')}
          >
            <dt className="font-medium">{t('settlement.charges')}</dt>
            <dd className="text-end" data-testid="settle-charges">
              {format.money(settlement.chargesMinor)}
            </dd>
            <dt>{t('settlement.unbilled')}</dt>
            <dd className="text-end" data-testid="settle-unbilled">
              {format.money(settlement.unbilledMinor)}
            </dd>
            <dt className="font-medium">{t('settlement.invoiced')}</dt>
            <dd className="text-end" data-testid="settle-invoiced">
              {format.money(settlement.invoicedMinor)}
            </dd>
            <dt>{t('settlement.credited')}</dt>
            <dd className="text-end">{format.money(settlement.creditedMinor)}</dd>
            <dt>{t('settlement.paid')}</dt>
            <dd className="text-end">{format.money(settlement.paidMinor)}</dd>
            <dt className="font-semibold">{t('settlement.due')}</dt>
            <dd className="text-end font-semibold" data-testid="settle-due">
              {format.money(settlement.dueMinor)}
            </dd>
            <dt>{t('settlement.held')}</dt>
            <dd className="text-end" data-testid="settle-held">
              {format.money(settlement.depositsHeldMinor)}
            </dd>
            <dt>{t('settlement.excess')}</dt>
            <dd className="text-end" data-testid="settle-excess">
              {format.money(settlement.excessDepositMinor)}
            </dd>
          </dl>
          <p className="text-sm" data-testid="match">
            {settlement.unbilledMinor === 0 && settlement.invoicedMinor === settlement.chargesMinor
              ? t('settlement.matches')
              : settlement.unbilledMinor > 0
                ? t('settlement.notYet', { amount: format.money(settlement.unbilledMinor) })
                : t('settlement.differs')}
          </p>
          <div className="flex flex-wrap gap-2">
            {canInvoice && settlement.unbilledMinor > 0 && (
              <Button asChild variant="outline">
                <Link to={`/billing/new?encounterId=${encounterId}`}>{t('settlement.make')}</Link>
              </Button>
            )}
            {applying && target && (
              <Button
                type="button"
                variant="outline"
                aria-disabled={apply.isPending || undefined}
                onClick={() => {
                  if (!apply.isPending) void setAgainst(target);
                }}
              >
                {apply.isPending
                  ? t('settlement.applying')
                  : t('settlement.apply', { number: target.number ?? '' })}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('settlement.modes')}</p>
          {canRefund && settlement.excessDepositMinor > 0 && (
            <DepositRefundForm
              admissionId={admissionId}
              excessMinor={settlement.excessDepositMinor}
              onDone={(text, failed) => setMessage({ text, failed })}
            />
          )}
        </>
      )}
    </section>
  );
}
