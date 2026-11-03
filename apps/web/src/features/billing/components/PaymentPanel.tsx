import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { currencyDigits, toMinor } from '@/features/services';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { cn } from '@/shared/lib/utils';
import { useFormatters, useTenant } from '@/tenancy';
import { usePayments, useRecordPayment } from '../hooks/use-billing';
import {
  createPaymentSchema,
  PAYMENT_METHODS,
  REFERENCE_MAX,
  type PaymentInput,
  type PaymentValues,
} from '../schemas';
import type { Invoice, Payment } from '../types';

/** Refusals of the API that have words of their own; any other failure gets the generic ones. */
const REFUSALS = new Set(['overpayment', 'no_open_register', 'invoice_not_payable']);

/** An amount in minor units as the digits a person types: 12550 is "125.50" in two decimals. */
function amountText(minor: number, digits: number): string {
  const text = String(minor).padStart(digits + 1, '0');
  return digits === 0 ? text : `${text.slice(0, -digits)}.${text.slice(-digits)}`;
}

/**
 * The payments of an issued invoice (#111): what was taken and what is still due, and, for
 * `payment:create`, a form to take a payment, in part or in full, in one of the payment modes.
 * The payments are listed for `payment:read`.
 */
export function PaymentPanel({ invoice }: { invoice: Invoice }) {
  const { t } = useTranslation('billing');
  const canRead = usePermission('payment:read');
  const canCreate = usePermission('payment:create');
  const format = useFormatters();
  const payments = usePayments(invoice.id, { enabled: canRead });
  // The sending and what came of it live here, above the form, which is made again whenever the
  // balance changes: a refusal that changed the balance is still shown, and the idempotency key
  // of a payment still unanswered is not lost with the form.
  const record = useRecordPayment(invoice.id);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const dueMinor = invoice.totalMinor - invoice.paidMinor - invoice.creditedMinor;
  const payable = canCreate && invoice.status === 'issued' && dueMinor > 0;

  // When the form goes (the last payment, or a refusal that says the invoice can take none) focus
  // moves to the status line, once it holds what happened: it is hidden while empty.
  const formWas = useRef(payable);
  const formLeft = useRef(false);
  useEffect(() => {
    if (formWas.current && !payable) formLeft.current = true;
    formWas.current = payable;
  }, [payable]);
  useEffect(() => {
    if (formLeft.current && message && !payable) {
      formLeft.current = false;
      focusIfLost(status.current);
    }
  }, [message, payable]);

  const columns = useMemo<GridColumn<Payment>[]>(
    () => [
      { id: 'at', header: t('payment.columns.at'), value: (row) => format.dateTime(row.at) },
      {
        id: 'kind',
        header: t('payment.columns.kind'),
        value: (row) => t(`payment.kind.${row.kind}`),
      },
      {
        id: 'method',
        header: t('payment.columns.method'),
        value: (row) => t(`payment.methods.${row.method}`),
      },
      {
        id: 'reference',
        header: t('payment.columns.reference'),
        value: (row) => row.reference ?? '',
      },
      { id: 'by', header: t('payment.columns.by'), value: (row) => row.recordedByName },
      {
        id: 'amount',
        header: t('payment.columns.amount'),
        // A refund takes money back: it reads as less, not as one more payment.
        value: (row) => format.money(row.kind === 'refund' ? -row.amountMinor : row.amountMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <section aria-labelledby="payments-heading" className="flex flex-col gap-3">
      <h2 id="payments-heading" className="text-lg font-semibold">
        {t('payment.heading')}
      </h2>
      <p className="text-sm" data-testid="balance-due">
        {t('payment.due', { due: format.money(dueMinor) })}
      </p>
      {/* Always on the page, so a saved or refused payment is announced. */}
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
      {payable && (
        <PaymentForm
          // A new balance is a new form: its limit and its first amount follow what is due.
          key={dueMinor}
          record={record}
          dueMinor={dueMinor}
          onRecorded={(amountMinor) =>
            setMessage({
              text: t('payment.recorded', { amount: format.money(amountMinor) }),
              failed: false,
            })
          }
          onRefused={(text) => setMessage({ text, failed: true })}
        />
      )}
      {canRead && (
        <DataGrid
          label={t('payment.heading')}
          columns={columns}
          rows={payments.data ?? []}
          rowId={(row) => row.id}
          rowLabel={(row) => `${t(`payment.kind.${row.kind}`)} ${format.money(row.amountMinor)}`}
          status={payments.isPending ? 'loading' : payments.isError ? 'error' : 'ready'}
          emptyMessage={t('payment.none')}
          onRetry={() => void payments.refetch()}
        />
      )}
    </section>
  );
}

function PaymentForm({
  record,
  dueMinor,
  onRecorded,
  onRefused,
}: {
  record: ReturnType<typeof useRecordPayment>;
  dueMinor: number;
  onRecorded: (amountMinor: number) => void;
  onRefused: (text: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(
    () => createPaymentSchema((text) => toMinor(text, digits), dueMinor),
    [digits, dueMinor],
  );
  // Paying in full is one press: the amount starts as everything still due.
  const form = useZodForm<PaymentInput, PaymentValues>(schema, {
    amount: amountText(dueMinor, digits),
    method: 'cash',
    reference: '',
  });

  async function submit(values: PaymentValues) {
    const amountMinor = toMinor(values.amount, digits) ?? 0;
    try {
      await record.mutateAsync({
        amountMinor,
        method: values.method,
        ...(values.reference ? { reference: values.reference } : {}),
      });
      onRecorded(amountMinor);
    } catch (error) {
      const code = isApiError(error) ? error.serverCode : undefined;
      onRefused(
        code && REFUSALS.has(code) ? t(`payment.refused.${code}`) : tCommon(errorMessageKey(error)),
      );
    }
  }

  return (
    <Form form={form} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField<PaymentInput>
          name="amount"
          label={t('payment.amount')}
          hint={t('payment.amountHint', { due: format.money(dueMinor) })}
          required
          inputMode="decimal"
          autoComplete="off"
        />
        <SelectField<PaymentInput>
          name="method"
          label={t('payment.method')}
          required
          options={PAYMENT_METHODS.map((value) => ({
            value,
            label: t(`payment.methods.${value}`),
          }))}
        />
      </div>
      <TextField<PaymentInput>
        name="reference"
        label={t('payment.reference')}
        hint={t('payment.referenceHint')}
        maxLength={REFERENCE_MAX}
        autoComplete="off"
      />
      <div>
        <SubmitButton pending={record.isPending}>
          {record.isPending ? t('payment.saving') : t('payment.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
