import { useCallback, useEffect, useMemo, useRef } from 'react';
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
import { useRefundPayment } from '../hooks/use-billing';
import { amountText, refusalText } from '../lib/panel-helpers';
import type { Refundable } from '../lib/refundable';
import { createRefundSchema, REASON_MAX, type RefundInput, type RefundValues } from '../schemas';

/** Refusals of the API that have words of their own; any other failure gets the generic ones. */
const REFUSALS = new Set(['refund_exceeds', 'no_open_register']);

export interface RefundDraft {
  paymentId: string;
  reason: string;
}

/**
 * The form to refund a payment (#444), for `payment:refund`: which payment, how much of what it
 * holds and why. The sending is one key per body, so a double press refunds once. A cash refund
 * comes out of the caller's open cash register session; the server says when there is none.
 */
export function RefundForm({
  options,
  draft,
  onDraft,
  onRefunded,
  onRefused,
}: {
  options: Refundable[];
  /** What was typed, kept by the panel: the form is made again when what a payment holds changes. */
  draft: RefundDraft;
  onDraft: (draft: RefundDraft) => void;
  onRefunded: (amountMinor: number) => void;
  onRefused: (text: string) => void;
}) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const digits = currencyDigits(useTenant()?.currency);
  const refund = useRefundPayment();
  const held = useCallback(
    (id: string) => options.find((each) => each.payment.id === id)?.heldMinor ?? 0,
    [options],
  );
  const schema = useMemo(
    () => createRefundSchema((text) => toMinor(text, digits), held),
    [digits, held],
  );
  // The payment chosen and the reason typed before the form was made again are kept.
  const kept = options.find((each) => each.payment.id === draft.paymentId) ?? options[0];
  const form = useZodForm<RefundInput, RefundValues>(schema, {
    paymentId: kept?.payment.id ?? '',
    amount: amountText(kept?.heldMinor ?? 0, digits),
    reason: draft.reason,
  });
  const chosen = form.watch('paymentId');
  const reason = form.watch('reason');
  useEffect(() => {
    // Only a payment the person picked is kept; otherwise the most recent one is the start.
    onDraft({ paymentId: chosen === options[0]?.payment.id ? '' : chosen, reason });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onDraft only stores, `options` is read as it was
  }, [chosen, reason]);
  // Choosing another payment starts the amount as everything that payment holds.
  const shown = useRef(chosen);
  useEffect(() => {
    if (shown.current === chosen) return;
    shown.current = chosen;
    form.setValue('amount', amountText(held(chosen), digits));
    form.clearErrors('amount');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a change of payment resets it
  }, [chosen]);

  async function submit(values: RefundValues) {
    const amountMinor = toMinor(values.amount, digits) ?? 0;
    try {
      await refund.mutateAsync({
        paymentId: values.paymentId,
        amountMinor,
        reason: values.reason,
      });
      onRefunded(amountMinor);
    } catch (error) {
      onRefused(refusalText(error, REFUSALS, 'refund', t, tCommon));
    }
  }

  return (
    <section aria-labelledby="refund-heading" className="flex flex-col gap-3">
      <h3 id="refund-heading" className="text-base font-semibold">
        {t('refund.heading')}
      </h3>
      <Form form={form} onSubmit={submit}>
        <SelectField<RefundInput>
          name="paymentId"
          label={t('refund.payment')}
          required
          options={options.map(({ payment, heldMinor }) => ({
            value: payment.id,
            label: t('refund.paymentOption', {
              kind: t(`payment.kind.${payment.kind}`),
              method: t(`payment.methods.${payment.method}`),
              date: format.dateTime(payment.at),
              held: format.money(heldMinor),
            }),
          }))}
        />
        <TextField<RefundInput>
          name="amount"
          label={t('refund.amount')}
          hint={t('refund.amountHint', { held: format.money(held(chosen)) })}
          required
          inputMode="decimal"
          autoComplete="off"
        />
        <TextAreaField<RefundInput>
          name="reason"
          label={t('refund.reason')}
          hint={t('refund.reasonHint')}
          required
          maxLength={REASON_MAX}
        />
        <div>
          <SubmitButton pending={refund.isPending}>
            {refund.isPending ? t('refund.saving') : t('refund.submit')}
          </SubmitButton>
        </div>
      </Form>
    </section>
  );
}
