import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits } from '@/features/services';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { StatusBadge } from '@/shared/ui/status-badge';
import { useFormatters, useTenant } from '@/tenancy';
import {
  receiptFormSchema,
  receiptReconciles,
  RECEIPT_METHODS,
  todayAt,
  toReceiptCreate,
  type ReceiptFormValues,
} from '../credit';
import { useRecordReceipt } from '../hooks/use-credit';
import type { CreditAccount, Receipt } from '../types';
import { PrintAction, ReceiptDocument } from './CreditPrint';
import { refusalKey } from './refusal';

/**
 * Records money received from a corporate. The server sets it against the oldest unpaid bills
 * and answers with the receipt, which the dialog then shows with where it went and can print.
 */
export function ReceiptDialog({
  account,
  onClose,
}: {
  account: CreditAccount;
  onClose: () => void;
}) {
  const { t } = useTranslation('insurance');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const tenant = useTenant();
  const digits = currencyDigits(tenant?.currency);
  const today = todayAt(tenant?.timezone);
  const schema = useMemo(
    () => receiptFormSchema(digits, today, account.outstandingMinor),
    [digits, today, account.outstandingMinor],
  );
  const form = useZodForm(schema, {
    amount: '',
    method: 'bank_transfer',
    reference: '',
    receivedOn: today,
  });
  const record = useRecordReceipt(account.payerId);
  const [done, setDone] = useState<Receipt>();
  const refused = refusalKey(record.error);

  const submit = async (values: ReceiptFormValues) => {
    try {
      setDone(await record.mutateAsync(toReceiptCreate(values, digits)));
    } catch {
      // Said below, from the mutation state.
    }
  };

  if (done) {
    const adds = receiptReconciles(done);
    return (
      <Dialog
        open
        onOpenChange={(next) => !next && onClose()}
        title={t('credit.receipt.doneTitle', { number: done.number })}
        description={t('credit.receipt.doneDescription', {
          amount: format.money(done.amountMinor),
        })}
        closeLabel={t('close')}
        footer={
          <>
            <PrintAction label={t('credit.receipt.print')}>
              <ReceiptDocument receipt={done} />
            </PrintAction>
            <Button onClick={onClose}>{t('credit.receipt.done')}</Button>
          </>
        }
      >
        <p role="status" className="sr-only">
          {t('credit.receipt.saved', { number: done.number })}
        </p>
        <ul className="flex flex-col gap-1 text-sm" aria-label={t('credit.print.appliedTo')}>
          {done.allocations.map((one) => (
            <li key={one.billId} className="flex justify-between gap-4">
              <span>{one.billNumber}</span>
              <span className="tabular-nums">{format.money(one.amountMinor)}</span>
            </li>
          ))}
        </ul>
        <StatusBadge
          tone={adds ? 'success' : 'danger'}
          label={adds ? t('credit.receipt.reconciled') : t('credit.receipt.notReconciled')}
        />
      </Dialog>
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('credit.receipt.title')}
      description={t('credit.receipt.description', {
        name: account.payerName,
        amount: format.money(account.outstandingMinor),
      })}
      closeLabel={t('close')}
      busy={record.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="credit-receipt-form" aria-busy={record.isPending}>
            {record.isPending ? t('saving') : t('credit.receipt.submit')}
          </Button>
        </>
      }
    >
      <Form form={form} id="credit-receipt-form" onSubmit={submit} className="flex flex-col gap-4">
        <TextField<ReceiptFormValues>
          name="amount"
          label={t('credit.receipt.amount')}
          hint={t('credit.receipt.amountHint')}
          required
          inputMode="decimal"
          autoComplete="off"
        />
        <SelectField<ReceiptFormValues>
          name="method"
          label={t('credit.receipt.method')}
          required
          options={RECEIPT_METHODS.map((value) => ({
            value,
            label: t(`credit.method.${value}`),
          }))}
        />
        <TextField<ReceiptFormValues>
          name="reference"
          label={t('credit.receipt.reference')}
          hint={t('credit.receipt.referenceHint')}
          maxLength={60}
          autoComplete="off"
        />
        <TextField<ReceiptFormValues>
          name="receivedOn"
          label={t('credit.receipt.date')}
          type="date"
          required
        />
        {record.error && (
          <p role="alert" className="text-sm text-destructive">
            {refused ? t(refused) : tCommon(errorMessageKey(record.error))}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
