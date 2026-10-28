import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useStepIndent } from '../hooks/use-indents';
import { useItemName } from '../hooks/use-item-name';
import { createApproveFormSchema, type ApproveFormValues } from '../schemas';
import type { StockIndent } from '../types';
import { INDENT_REFUSED } from './refusals';

/**
 * Approving a requested indent someone else asked for (#105), for `indent:approve`, in a panel in
 * place: the units approved of each line, started at what it asked, each up to that and 0 for an
 * item the store will not give, with the store's stock of it beside. Nothing moves until it is
 * issued. Shown with `data-panel-heading` for the panel's focus.
 */
export function ApprovePanel({
  indent,
  onClose,
  onApproved,
}: {
  indent: StockIndent;
  onClose: () => void;
  onApproved: (indent: StockIndent) => void;
}) {
  const { t } = useTranslation('indents');
  const { t: tCommon } = useTranslation();
  const nameOf = useItemName();
  const headingId = useId();
  // Taken when the panel opens, with the version it is sent at, so the units typed stay with their
  // lines and a change by someone else meanwhile is refused (409 conflict).
  const [{ lines, version }] = useState(() => ({ lines: indent.lines, version: indent.version }));
  const schema = useMemo(
    () => createApproveFormSchema(lines.map((line) => line.requestedQuantity)),
    [lines],
  );
  const form = useZodForm<ApproveFormValues, ApproveFormValues>(schema, {
    units: lines.map((line) => String(line.requestedQuantity)),
  });
  const approve = useStepIndent();
  const code = isApiError(approve.error) ? approve.error.serverCode : undefined;
  const failure = approve.error
    ? code !== undefined && INDENT_REFUSED[code]
      ? t(INDENT_REFUSED[code])
      : tCommon(errorMessageKey(approve.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: ApproveFormValues) => {
    approve.reset();
    try {
      onApproved(
        await approve.mutateAsync({
          indent: { ...indent, version },
          change: {
            step: 'approve',
            lines: lines.map((line, index) => ({
              lineId: line.id,
              quantity: Number(values.units[index]),
            })),
          },
        }),
      );
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('approve.heading', { reference: indent.reference })}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t('approve.description', { store: indent.toLocationName })}
      </p>
      <Form form={form} onSubmit={submit} className="flex flex-col gap-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {lines.map((line, index) => (
            <TextField
              key={line.id}
              name={`units.${index}`}
              label={t('approve.units', { name: nameOf(line.item) })}
              hint={
                line.storeOnHand === undefined
                  ? t('approve.askedHint', { asked: line.requestedQuantity })
                  : t('approve.unitsHint', {
                      asked: line.requestedQuantity,
                      count: line.storeOnHand,
                    })
              }
              inputMode="numeric"
              autoComplete="off"
              required
            />
          ))}
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
          <SubmitButton pending={approve.isPending}>{t('approve.submit')}</SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('closePanel')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
