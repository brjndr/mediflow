import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { currencyDigits, toMinor } from '@/features/services';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { useRefundDeposits } from '../hooks/use-stay-bill';
import { amountText, refusalText } from '../lib/panel-helpers';
import { PAYMENT_METHODS } from '../schemas';
import {
  createDepositRefundSchema,
  REASON_MAX,
  type DepositRefundInput,
  type DepositRefundValues,
} from '../stay-bill';

const REFUSALS = new Set(['refund_exceeds', 'no_open_register']);

/**
 * Pays back the deposit held beyond what is due (DS-04, #167), for `payment:refund`: an amount up
 * to that excess (it starts as all of it), the mode it goes back by and a required reason. One
 * key per body, so a double press pays back once.
 */
export function DepositRefundForm({
  admissionId,
  excessMinor,
  onDone,
}: {
  admissionId: string;
  excessMinor: number;
  onDone: (text: string, failed: boolean) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const digits = currencyDigits(useTenant()?.currency);
  const refund = useRefundDeposits(admissionId);
  const schema = useMemo(
    () => createDepositRefundSchema((text) => toMinor(text, digits), excessMinor),
    [digits, excessMinor],
  );
  const form = useZodForm<DepositRefundInput, DepositRefundValues>(schema, {
    amount: amountText(excessMinor, digits),
    method: 'cash',
    reason: '',
  });

  async function submit(values: DepositRefundValues) {
    const amountMinor = toMinor(values.amount, digits) ?? 0;
    try {
      await refund.mutateAsync({ amountMinor, method: values.method, reason: values.reason });
      onDone(t('settlement.refunded', { amount: format.money(amountMinor) }), false);
    } catch (error) {
      onDone(refusalText(error, REFUSALS, 'settlement', t, tCommon), true);
    }
  }

  return (
    <section aria-labelledby="deposit-refund-heading" className="flex flex-col gap-3">
      <h3 id="deposit-refund-heading" className="text-base font-semibold">
        {t('settlement.refund.heading')}
      </h3>
      <Form form={form} onSubmit={submit}>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <TextField<DepositRefundInput>
            name="amount"
            label={t('settlement.refund.amount')}
            hint={t('settlement.refund.hint', { held: format.money(excessMinor) })}
            required
            inputMode="decimal"
            autoComplete="off"
          />
          <SelectField<DepositRefundInput>
            name="method"
            label={t('settlement.refund.method')}
            required
            options={PAYMENT_METHODS.map((value) => ({
              value,
              label: t(`payment.methods.${value}`),
            }))}
          />
        </div>
        <TextAreaField<DepositRefundInput>
          name="reason"
          label={t('refund.reason')}
          hint={t('refund.reasonHint')}
          required
          maxLength={REASON_MAX}
        />
        <div>
          <SubmitButton pending={refund.isPending}>
            {refund.isPending ? t('refund.saving') : t('settlement.refund.submit')}
          </SubmitButton>
        </div>
      </Form>
    </section>
  );
}
