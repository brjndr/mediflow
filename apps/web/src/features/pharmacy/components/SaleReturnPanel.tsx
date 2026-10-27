import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useSaleReturn } from '../hooks/use-sales';
import { createReturnFormSchema, type ReturnFormValues } from '../sales-schemas';
import { REASON_MAX } from '../schemas';
import type { PharmacySale } from '../types';

const REFUSED: Record<string, string> = {
  over_return: 'sale.return.refused.over',
  unknown_line: 'sale.return.refused.line',
  batch_expired: 'sale.return.refused.expired',
  unknown_location: 'sale.return.refused.place',
  sale_not_found: 'sale.return.refused.gone',
};

/**
 * Bringing units of a sale back into stock (#101), for `sale:return`, in a panel in place: the
 * units of each line still to return, and why. An expired batch is refused (it is wastage). Shown
 * with `data-panel-heading` for the panel's focus.
 */
export function SaleReturnPanel({
  sale,
  onClose,
  onReturned,
}: {
  sale: PharmacySale;
  onClose: () => void;
  onReturned: () => void;
}) {
  const { t } = useTranslation('pharmacy');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const headingId = useId();
  // Taken when the panel opens: the units typed stay with their line however the sale is read
  // again, and a line returned meanwhile is refused by the server (409 over_return).
  const [lines] = useState(() =>
    sale.lines.filter((line) => line.quantity > line.returnedQuantity),
  );
  const left = useMemo(() => lines.map((line) => line.quantity - line.returnedQuantity), [lines]);
  const schema = useMemo(() => createReturnFormSchema(left), [left]);
  const form = useZodForm<ReturnFormValues, ReturnFormValues>(schema, {
    reason: '',
    units: lines.map(() => ''),
  });
  const back = useSaleReturn(sale.id);
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
      await back.mutateAsync({
        reason: values.reason,
        lines: lines.flatMap((line, index) => {
          const units = Number(values.units[index] || 0);
          return units > 0 ? [{ saleLineId: line.id, quantity: units }] : [];
        }),
      });
      onReturned();
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('sale.return.heading')}
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
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {lines.map((line, index) => (
            <TextField
              key={line.id}
              name={`units.${index}`}
              label={t('sale.return.units', {
                name: line.itemName,
                number: line.batchNumber,
              })}
              hint={t('sale.return.unitsHint', {
                count: left[index] ?? 0,
                price: format.money(Number(line.unitPriceMinor)),
              })}
              inputMode="numeric"
              autoComplete="off"
            />
          ))}
        </div>
        <TextField
          name="reason"
          label={t('sale.return.reason')}
          required
          maxLength={REASON_MAX}
          autoComplete="off"
        />
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={back.isPending}>
            {back.isPending ? t('sale.return.submitting') : t('sale.return.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
