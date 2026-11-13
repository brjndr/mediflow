import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { usePermission } from '@/access';
import type { SlotProps } from '@/registry';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { useFormatters } from '@/tenancy';
import { useCreateCreditBill, useCreditAccounts } from '../hooks/use-credit';
import type { CreditBill } from '../types';
import { refusalKey } from './refusal';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * "Bill to a corporate on credit" (`invoice.builder.panels`, IN-05, #185), for `receivable:manage`
 * and `receivable:read`: the whole visit is put on a corporate's credit account, to be paid by
 * its due date, instead of being invoiced to the patient. The server totals the ledger and
 * refuses a bill beyond the credit left. Shows nothing when no corporate has an account.
 */
export default function CreditBillPanel({ context }: SlotProps) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canManage = usePermission('receivable:manage');
  const canRead = usePermission('receivable:read');
  const encounterId =
    typeof context?.encounterId === 'string' && ID.test(context.encounterId)
      ? context.encounterId
      : '';
  const enabled = canManage && canRead && encounterId !== '';
  const accounts = useCreditAccounts(enabled);
  const create = useCreateCreditBill(encounterId);
  const [payerId, setPayerId] = useState('');
  const [bill, setBill] = useState<CreditBill>();

  const items = accounts.data?.pages.flatMap((page) => page.items) ?? [];
  if (!enabled || accounts.isPending || items.length === 0) return null;
  const refused = refusalKey(create.error);
  const blocked = payerId === '' || create.isPending || bill !== undefined;

  return (
    <section
      aria-labelledby="credit-bill-heading"
      className="flex flex-col gap-3 rounded-md border p-3"
    >
      <h2 id="credit-bill-heading" className="text-lg font-semibold">
        {t('credit.panel.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('credit.panel.description')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm font-medium">
          {t('credit.panel.corporate')}
          <select
            value={payerId}
            onChange={(event) => setPayerId(event.target.value)}
            className="h-9 rounded-md border bg-background px-2 text-base md:text-sm pointer-coarse:h-11"
          >
            <option value="">{t('credit.panel.choose')}</option>
            {items.map((account) => (
              <option key={account.payerId} value={account.payerId}>
                {t('credit.panel.option', {
                  name: account.payerName,
                  available: format.money(account.availableMinor),
                })}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="outline"
          aria-disabled={blocked || undefined}
          onClick={() => {
            if (blocked) return;
            create.mutate(payerId, { onSuccess: setBill });
          }}
        >
          {create.isPending ? t('saving') : t('credit.panel.submit')}
        </Button>
      </div>
      {/* Always on the page, so the result is announced. */}
      <p role="status" className={bill || create.isError ? 'text-sm' : 'sr-only'}>
        {bill
          ? t('credit.panel.saved', {
              number: bill.number,
              name: bill.payerName,
              amount: format.money(bill.amountMinor),
              due: format.calendarDate(bill.dueOn),
            })
          : create.isError
            ? refused
              ? t(refused)
              : tCommon(errorMessageKey(create.error))
            : ''}{' '}
        {bill && (
          <Link to={`/credit/${bill.payerId}`} className="font-medium underline">
            {t('credit.panel.open')}
          </Link>
        )}
      </p>
    </section>
  );
}
