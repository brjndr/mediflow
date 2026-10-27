import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useReturnToSupplier } from '../hooks/use-purchasing';
import {
  createReturnFormSchema,
  NOTE_MAX,
  RETURN_REASONS,
  type ReturnFormValues,
} from '../schemas';
import type { GoodsReceipt, PurchaseReturn } from '../types';

const REFUSED: Record<string, string> = {
  over_return: 'return.refused.over',
  insufficient_stock: 'return.refused.insufficient',
  receipt_not_found: 'return.refused.gone',
  validation_failed: 'return.refused.invalid',
  unknown_location: 'return.refused.place',
};

/**
 * Units of a goods receipt sent back to its supplier (#103), for `purchaseReturn:create`, in a
 * panel in place: the units of each line still kept, a reason, and a note (needed for another
 * reason). They leave stock at the receipt's place at once; expired units may go back. Shown with
 * `data-panel-heading` for the panel's focus.
 */
export function ReturnPanel({
  receipt,
  onClose,
  onReturned,
}: {
  receipt: GoodsReceipt;
  onClose: () => void;
  onReturned: (back: PurchaseReturn) => void;
}) {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  // Taken when the panel opens: the units typed stay with their line however the receipt is
  // read again, and a line returned meanwhile is refused by the server (409 over_return).
  const [lines] = useState(() =>
    receipt.lines.filter((line) => line.quantity > line.returnedQuantity),
  );
  const left = useMemo(() => lines.map((line) => line.quantity - line.returnedQuantity), [lines]);
  const schema = useMemo(() => createReturnFormSchema(left), [left]);
  const form = useZodForm<ReturnFormValues, ReturnFormValues>(schema, {
    reason: 'damaged',
    note: '',
    units: lines.map(() => ''),
  });
  const back = useReturnToSupplier(receipt.id);
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

  const submit = async (values: ReturnFormValues) => {
    back.reset();
    try {
      onReturned(
        await back.mutateAsync({
          reason: values.reason,
          ...(values.note === '' ? {} : { note: values.note }),
          lines: lines.flatMap((line, index) => {
            const units = Number(values.units[index] || 0);
            return units > 0 ? [{ receiptLineId: line.id, quantity: units }] : [];
          }),
        }),
      );
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('return.heading', { supplier: receipt.supplierName })}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('return.description', { place: receipt.locationName })}
      </p>
      <Form form={form} onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {lines.map((line, index) => (
            <TextField
              key={line.id}
              name={`units.${index}`}
              label={t('return.units', { name: line.itemName, number: line.batchNumber })}
              hint={t('return.unitsHint', {
                count: left[index] ?? 0,
                expiry: format.calendarDate(line.expiryDate),
              })}
              inputMode="numeric"
              autoComplete="off"
            />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <SelectField
            name="reason"
            label={t('return.reason')}
            required
            options={RETURN_REASONS.map((each) => ({ value: each, label: t(`reason.${each}`) }))}
          />
          <TextField
            name="note"
            label={t('return.note')}
            hint={t('return.noteHint')}
            maxLength={NOTE_MAX}
            autoComplete="off"
          />
        </div>
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
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={back.isPending}>
            {back.isPending ? t('return.submitting') : t('return.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
