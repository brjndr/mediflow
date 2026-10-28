import { useId, useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useStepIndent } from '../hooks/use-indents';
import { endFormSchema, NOTE_MAX, type EndFormValues } from '../schemas';
import type { StockIndent } from '../types';
import { INDENT_REFUSED } from './refusals';

/**
 * Rejecting a requested indent (`indent:approve`) or closing an approved one with units still to
 * issue (`indent:issue`), with a note saying why (#105). Shown in place, with
 * `data-panel-heading` for the panel's focus.
 */
export function EndPanel({
  indent,
  step,
  onClose,
  onDone,
}: {
  indent: StockIndent;
  step: 'reject' | 'close';
  onClose: () => void;
  onDone: (indent: StockIndent) => void;
}) {
  const { t } = useTranslation('indents');
  const { t: tCommon } = useTranslation();
  const headingId = useId();
  // The version the panel opened at: a change by someone else meanwhile is refused (409 conflict).
  const [version] = useState(indent.version);
  const form = useZodForm(endFormSchema, { note: '' });
  const end = useStepIndent();
  const code = isApiError(end.error) ? end.error.serverCode : undefined;
  const failure = end.error
    ? code !== undefined && INDENT_REFUSED[code]
      ? t(INDENT_REFUSED[code])
      : tCommon(errorMessageKey(end.error))
    : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  const submit = async (values: EndFormValues) => {
    end.reset();
    try {
      onDone(
        await end.mutateAsync({
          indent: { ...indent, version },
          change: { step, note: values.note },
        }),
      );
    } catch {
      // Said from the mutation state.
    }
  };

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t(`end.${step}Heading`, { reference: indent.reference })}
      </h2>
      <p className="text-sm text-muted-foreground">{t(`end.${step}Description`)}</p>
      <Form form={form} onSubmit={submit}>
        <TextField
          name="note"
          label={t('end.note')}
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
          <SubmitButton pending={end.isPending}>{t(`end.${step}Submit`)}</SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('closePanel')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
