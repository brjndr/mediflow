import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { todayIn } from '@/shared/utils';
import { useFormatters, useTenant } from '@/tenancy';
import { useDispenseReturn } from '../hooks/use-pharmacy';
import {
  createDispenseReturnFormSchema,
  REASON_MAX,
  type DispenseReturnFormValues,
} from '../schemas';
import type { Dispense } from '../types';

const REFUSED: Record<string, string> = {
  over_return: 'dispenseReturn.refused.over',
  unknown_batch: 'dispenseReturn.refused.batch',
  batch_expired: 'dispenseReturn.refused.expired',
  unknown_location: 'dispenseReturn.refused.place',
  dispense_not_found: 'dispenseReturn.refused.gone',
};

/**
 * Bringing units of a dispense back (#104), for `dispense:return`, in a panel in place: for each
 * batch with units still out, the units back to stock at the dispense's place and the units
 * wasted (brought back and destroyed), and why. A batch expired at the hospital today is offered
 * as wastage only. Shown with `data-panel-heading` for the panel's focus.
 */
export function DispenseReturnPanel({
  prescriptionId,
  dispense,
  onClose,
  onReturned,
}: {
  prescriptionId: string;
  dispense: Dispense;
  onClose: () => void;
  onReturned: (units: number) => void;
}) {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const today = todayIn(useTenant()?.timezone ?? 'UTC');
  const headingId = useId();
  // Taken when the panel opens: the units typed stay with their batch however the prescription
  // is read again, and units returned meanwhile are refused by the server (409 over_return).
  const [batches] = useState(() =>
    dispense.batches
      .filter((batch) => batch.quantity > batch.returnedQuantity)
      .map((batch) => ({
        ...batch,
        left: batch.quantity - batch.returnedQuantity,
        expired: batch.expiryDate < today,
      })),
  );
  const schema = useMemo(() => createDispenseReturnFormSchema(batches), [batches]);
  const form = useZodForm<DispenseReturnFormValues, DispenseReturnFormValues>(schema, {
    reason: '',
    restock: batches.map(() => ''),
    waste: batches.map(() => ''),
  });
  const back = useDispenseReturn(prescriptionId, dispense.id);
  const code = isApiError(back.error) ? back.error.serverCode : undefined;
  const failure = back.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(back.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: DispenseReturnFormValues) => {
    back.reset();
    const lines = batches.flatMap((batch, index) => {
      const restockQuantity = batch.expired ? 0 : Number(values.restock[index] || 0);
      const wasteQuantity = Number(values.waste[index] || 0);
      return restockQuantity + wasteQuantity > 0
        ? [{ batchId: batch.batchId, restockQuantity, wasteQuantity }]
        : [];
    });
    try {
      await back.mutateAsync({ reason: values.reason, lines });
      onReturned(lines.reduce((sum, line) => sum + line.restockQuantity + line.wasteQuantity, 0));
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('dispenseReturn.heading', { item: dispense.itemName })}
      </h2>
      {failure && (
        <p
          ref={alert}
          role="alert"
          tabIndex={-1}
          className="text-sm text-destructive outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
          {failure}
        </p>
      )}
      <Form form={form} onSubmit={submit} className="flex flex-col gap-3">
        {batches.map((batch, index) => (
          <fieldset key={batch.batchId} className="flex flex-col gap-2">
            <legend className="text-sm font-medium">
              {t('dispenseReturn.batch', {
                number: batch.batchNumber,
                expiry: format.calendarDate(batch.expiryDate),
                count: batch.left,
              })}
            </legend>
            {batch.expired && (
              <p className="text-sm text-muted-foreground">{t('dispenseReturn.expired')}</p>
            )}
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {!batch.expired && (
                <TextField
                  name={`restock.${index}`}
                  label={t('dispenseReturn.restock', { number: batch.batchNumber })}
                  inputMode="numeric"
                  autoComplete="off"
                />
              )}
              <TextField
                name={`waste.${index}`}
                label={t('dispenseReturn.waste', { number: batch.batchNumber })}
                hint={t('dispenseReturn.wasteHint')}
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
          </fieldset>
        ))}
        <TextField
          name="reason"
          label={t('dispenseReturn.reason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={back.isPending}>
            {back.isPending ? t('dispenseReturn.submitting') : t('dispenseReturn.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
