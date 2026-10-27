import { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useStepOrder } from '../hooks/use-purchasing';
import { endFormSchema, NOTE_MAX, type EndFormValues } from '../schemas';
import type { PurchaseOrder } from '../types';
import { ORDER_REFUSED } from './refusals';

/**
 * Cancelling an order nothing came in for, or closing one partly received when the rest will not
 * come (#103), for `purchaseOrder:create`, with a note saying why. Shown in place, with
 * `data-panel-heading` for the panel's focus.
 */
export function EndOrderPanel({
  order,
  step,
  onClose,
  onDone,
}: {
  order: PurchaseOrder;
  step: 'cancel' | 'close';
  onClose: () => void;
  onDone: (order: PurchaseOrder) => void;
}) {
  const { t } = useTranslation('purchasing');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  const form = useZodForm(endFormSchema, { note: '' });
  const end = useStepOrder();
  const code = isApiError(end.error) ? end.error.serverCode : undefined;
  const failure = end.error
    ? code !== undefined && ORDER_REFUSED[code]
      ? t(ORDER_REFUSED[code])
      : tCommon(errorMessageKey(end.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: EndFormValues) => {
    end.reset();
    try {
      onDone(await end.mutateAsync({ order, step, note: values.note }));
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t(`order.end.${step}Heading`, { reference: order.reference })}
      </h2>
      <p className="text-sm text-muted-foreground">{t(`order.end.${step}Description`)}</p>
      <Form form={form} onSubmit={submit}>
        <TextField
          name="note"
          label={t('order.end.note')}
          required
          maxLength={NOTE_MAX}
          autoComplete="off"
        />
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
          <SubmitButton pending={end.isPending}>{t(`order.end.${step}Submit`)}</SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
