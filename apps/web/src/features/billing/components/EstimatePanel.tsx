import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { usePermission } from '@/access';
import { currencyDigits, toMinor } from '@/features/services';
import { cn } from '@/shared/lib/utils';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters, useTenant } from '@/tenancy';
import { useSetEstimate } from '../hooks/use-stay-bill';
import { amountText, refusalText } from '../lib/panel-helpers';
import {
  createEstimateSchema,
  ESTIMATE_NOTE_MAX,
  type EstimateInput,
  type EstimateValues,
  type RunningBill,
} from '../stay-bill';

const NO_REFUSALS: ReadonlySet<string> = new Set();

/**
 * Estimate against actual (DS-03, #166): what the stay was expected to cost and how far the
 * charges so far are from it, in words and not by colour alone. Setting it is for `invoice:create`.
 */
export function EstimatePanel({ bill }: { bill: RunningBill }) {
  const { t } = useTranslation('billing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const canSet = usePermission('invoice:create');
  const digits = currencyDigits(useTenant()?.currency);
  const set = useSetEstimate(bill.admissionId);
  const [message, setMessage] = useState<{ text: string; failed: boolean } | null>(null);
  const schema = useMemo(() => createEstimateSchema((text) => toMinor(text, digits)), [digits]);
  const form = useZodForm<EstimateInput, EstimateValues>(schema, {
    amount: bill.estimateMinor === undefined ? '' : amountText(bill.estimateMinor, digits),
    note: bill.estimateNote ?? '',
  });

  const difference =
    bill.estimateMinor === undefined ? undefined : bill.chargesMinor - bill.estimateMinor;

  async function submit(values: EstimateValues) {
    try {
      await set.mutateAsync({
        amountMinor: toMinor(values.amount, digits) ?? 0,
        ...(values.note ? { note: values.note } : {}),
      });
      setMessage({ text: t('estimate.saved'), failed: false });
    } catch (error) {
      setMessage({ text: refusalText(error, NO_REFUSALS, 'estimate', t, tCommon), failed: true });
    }
  }

  return (
    <section aria-labelledby="estimate-heading" className="flex flex-col gap-3">
      <h2 id="estimate-heading" className="text-lg font-semibold">
        {t('estimate.heading')}
      </h2>
      <p className="text-sm" data-testid="estimate-summary">
        {bill.estimateMinor === undefined || difference === undefined
          ? t('estimate.none')
          : difference === 0
            ? t('estimate.on', { estimate: format.money(bill.estimateMinor) })
            : difference > 0
              ? t('estimate.over', {
                  estimate: format.money(bill.estimateMinor),
                  by: format.money(difference),
                })
              : t('estimate.under', {
                  estimate: format.money(bill.estimateMinor),
                  by: format.money(-difference),
                })}
      </p>
      {bill.estimateNote && <p className="text-sm text-muted-foreground">{bill.estimateNote}</p>}
      <p
        role="status"
        className={cn('text-sm empty:hidden', message?.failed && 'text-destructive')}
      >
        {message?.text}
      </p>
      {canSet && (
        <Form form={form} onSubmit={submit}>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <TextField<EstimateInput>
              name="amount"
              label={t('estimate.amount')}
              required
              inputMode="decimal"
              autoComplete="off"
            />
            <TextField<EstimateInput>
              name="note"
              label={t('estimate.note')}
              maxLength={ESTIMATE_NOTE_MAX}
              autoComplete="off"
            />
          </div>
          <div>
            <SubmitButton pending={set.isPending}>
              {set.isPending ? t('estimate.saving') : t('estimate.submit')}
            </SubmitButton>
          </div>
        </Form>
      )}
    </section>
  );
}
