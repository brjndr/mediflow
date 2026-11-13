import { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { currencyDigits, toMinor } from '@/features/services';
import { cn } from '@/shared/lib/utils';
import { DataGrid, type GridColumn } from '@/shared/ui/data-grid';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { useDeposits, useTakeDeposit } from '../hooks/use-stay-bill';
import { refusalText, useFocusWhenFormGoes } from '../lib/panel-helpers';
import {
  createPaymentSchema,
  PAYMENT_METHODS,
  REFERENCE_MAX,
  type PaymentInput,
  type PaymentValues,
} from '../schemas';
import type { Deposit } from '../stay-bill';

const REFUSALS = new Set(['no_open_register', 'stay_closed']);

/** A deposit has no upper limit on the form; the server decides. */
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * The deposits taken against an inpatient stay (DS-03, #166): listed for `payment:read`, and for
 * `payment:create` a form to take one while the patient is admitted. A deposit is never edited
 * or removed; it is set against the final invoice.
 */
export function DepositPanel({ admissionId, open }: { admissionId: string; open: boolean }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canRead = usePermission('payment:read');
  const canCreate = usePermission('payment:create');
  const deposits = useDeposits(admissionId, { enabled: canRead });
  const take = useTakeDeposit(admissionId);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const status = useRef<HTMLParagraphElement>(null);
  const taking = canCreate && open;
  useFocusWhenFormGoes(taking, message !== null, status);

  const columns = useMemo<GridColumn<Deposit>[]>(
    () => [
      { id: 'at', header: t('deposit.columns.at'), value: (row) => format.dateTime(row.at) },
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
        value: (row) => format.money(row.amountMinor),
        align: 'end',
      },
    ],
    [t, format],
  );

  return (
    <section aria-labelledby="deposits-heading" className="flex flex-col gap-3">
      <h2 id="deposits-heading" className="text-lg font-semibold">
        {t('deposit.heading')}
      </h2>
      {/* Always on the page, so a saved or refused deposit is announced. */}
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
      {taking && (
        <DepositForm
          take={take}
          onTaken={(amountMinor) =>
            setMessage({
              text: t('deposit.taken', { amount: format.money(amountMinor) }),
              failed: false,
            })
          }
          onRefused={(error) =>
            setMessage({
              text: refusalText(error, REFUSALS, 'deposit', t, tCommon),
              failed: true,
            })
          }
        />
      )}
      {canRead && (
        <DataGrid
          label={t('deposit.heading')}
          columns={columns}
          rows={deposits.data ?? []}
          rowId={(row) => row.id}
          rowLabel={(row) => format.money(row.amountMinor)}
          status={deposits.isPending ? 'loading' : deposits.isError ? 'error' : 'ready'}
          emptyMessage={t('deposit.none')}
          onRetry={() => void deposits.refetch()}
        />
      )}
    </section>
  );
}

function DepositForm({
  take,
  onTaken,
  onRefused,
}: {
  take: ReturnType<typeof useTakeDeposit>;
  onTaken: (amountMinor: number) => void;
  onRefused: (error: unknown) => void;
}) {
  const { t } = useTranslation('billing');
  const digits = currencyDigits(useTenant()?.currency);
  const schema = useMemo(
    () => createPaymentSchema((text) => toMinor(text, digits), NO_LIMIT),
    [digits],
  );
  const form = useZodForm<PaymentInput, PaymentValues>(schema, {
    amount: '',
    method: 'cash',
    reference: '',
  });

  async function submit(values: PaymentValues) {
    const amountMinor = toMinor(values.amount, digits) ?? 0;
    try {
      await take.mutateAsync({
        amountMinor,
        method: values.method,
        ...(values.reference ? { reference: values.reference } : {}),
      });
      form.reset({ amount: '', method: values.method, reference: '' });
      onTaken(amountMinor);
    } catch (error) {
      onRefused(error);
    }
  }

  return (
    <Form form={form} onSubmit={submit}>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <TextField<PaymentInput>
          name="amount"
          label={t('deposit.amount')}
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
        <SubmitButton pending={take.isPending}>
          {take.isPending ? t('deposit.saving') : t('deposit.submit')}
        </SubmitButton>
      </div>
    </Form>
  );
}
