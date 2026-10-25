import { useId, useLayoutEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import { useAmendResult } from '../hooks/use-lab';
import { amendSchema, type AmendValues } from '../schemas';
import type { LabResult } from '../types';

/** Refusals the person can do nothing about on this form, in words of their own. */
const REFUSED: Record<string, string> = {
  already_amended: 'amend.refused.alreadyAmended',
  invalid_transition: 'amend.refused.notOpen',
  result_not_found: 'amend.refused.gone',
};

/**
 * Correcting a result (#91, `labResult:enter`): the whole corrected value, an optional comment
 * and a reason, which the history keeps. The result is never changed: the correction is a new
 * result, read against the range the replaced one kept, and needs verifying again before the
 * doctor sees it. A result is corrected once (409 `already_amended`); a later correction
 * corrects the correction. Shown in place, with `data-panel-heading` for the panel's focus.
 */
export function AmendResult({
  result,
  onClose,
  onAmended,
}: {
  result: LabResult;
  onClose: () => void;
  onAmended: (amended: LabResult) => void;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const amend = useAmendResult();
  const numeric = result.resultType === 'numeric';
  const schema = useMemo(() => amendSchema(numeric), [numeric]);
  const form = useZodForm(schema, { value: '', comment: '', reason: '' });
  const headingId = useId();

  const submit = async (values: AmendValues) => {
    amend.reset();
    const comment = values.comment.trim();
    try {
      const amended = await amend.mutateAsync({
        result,
        body: {
          value: values.value.trim(),
          reason: values.reason.trim(),
          ...(comment ? { comment } : {}),
        },
      });
      onAmended(amended);
    } catch {
      // Said from the mutation state.
    }
  };

  const code = isApiError(amend.error) ? amend.error.serverCode : undefined;
  const failure = amend.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(amend.error))
    : undefined;
  // Corrected or gone meanwhile: what this panel holds would be refused again, so the button goes
  // and focus goes to what it says. The page was read again; closing shows it.
  const refused = code !== undefined && REFUSED[code] !== undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('amend.heading', { name: result.testName })}
      </h2>
      <p className="text-sm">
        {t('amend.was', {
          value: [result.value, result.unit].filter(Boolean).join(' '),
          name: result.enteredByName,
        })}
      </p>
      <Form form={form} onSubmit={submit}>
        {numeric ? (
          <TextField<AmendValues>
            name="value"
            label={result.unit ? t('amend.valueWithUnit', { unit: result.unit }) : t('amend.value')}
            required
            inputMode="decimal"
            autoComplete="off"
            className="md:max-w-48"
          />
        ) : (
          <TextAreaField<AmendValues> name="value" label={t('amend.value')} required rows={2} />
        )}
        <TextAreaField<AmendValues> name="comment" label={t('amend.comment')} rows={2} />
        <TextField<AmendValues>
          name="reason"
          label={t('amend.reason')}
          hint={t('amend.reasonHint')}
          required
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
          {!refused && (
            <SubmitButton pending={amend.isPending}>
              {amend.isPending ? t('amend.submitting') : t('amend.submit')}
            </SubmitButton>
          )}
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
