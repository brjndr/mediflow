import { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { CheckboxField, Form, SubmitButton, useFieldError, useZodForm } from '@/shared/ui/form';
import { useVerifyResults } from '../hooks/use-lab';
import { verifySchema, type VerifyValues } from '../schemas';
import type { LabOrderResults, LabResult, LabSample } from '../types';

/** Refusals of a verification: each reads the page again, so the page's status line says them. */
const REFUSED: Record<string, string> = {
  conflict: 'verify.refused.conflict',
  unknown_result: 'verify.refused.conflict',
  invalid_transition: 'verify.refused.notOpen',
  sample_not_found: 'verify.refused.gone',
};

/**
 * Verifying results (#91, `labResult:verify`): the current results still entered, each ticked
 * (all by default) with its value, unit, flag and who entered it, so what is verified is what
 * the verifier read. Sends their ids; one changed meanwhile is refused (409 `conflict`) and the
 * page is read again. Verified results are released to the doctor. Remounted (`key`) when the
 * results to verify change.
 */
export function VerifyResults({
  sample,
  results,
  onVerified,
  onRefused,
}: {
  sample: LabSample;
  results: LabResult[];
  onVerified: (answer: LabOrderResults, count: number) => void;
  onRefused: (message: string) => void;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const verify = useVerifyResults(sample.orderId);
  const headingId = useId();
  const form = useZodForm(verifySchema, {
    ticked: results.map((result) => ({ id: result.id, checked: true })),
  });

  const submit = async (values: VerifyValues) => {
    verify.reset();
    const resultIds = values.ticked.filter((each) => each.checked).map((each) => each.id);
    try {
      const answer = await verify.mutateAsync({ sampleId: sample.id, resultIds });
      onVerified(answer, resultIds.length);
    } catch (error) {
      const key = isApiError(error) ? REFUSED[error.serverCode ?? ''] : undefined;
      if (key) onRefused(t(key));
    }
  };

  const code = isApiError(verify.error) ? verify.error.serverCode : undefined;
  const failure =
    verify.error && !(code !== undefined && REFUSED[code])
      ? tCommon(errorMessageKey(verify.error))
      : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} className="font-semibold">
        {t('verify.heading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('verify.hint')}</p>
      <Form form={form} onSubmit={submit}>
        <fieldset className="flex flex-col gap-2">
          <legend className="sr-only">{t('verify.legend')}</legend>
          {results.map((result, index) => (
            <CheckboxField<VerifyValues>
              key={result.id}
              name={`ticked.${index}.checked`}
              label={t('verify.item', {
                name: result.testName,
                value: [result.value, result.unit].filter(Boolean).join(' '),
                flag: result.flag ? t(`flag.${result.flag}`) : t('flag.none'),
              })}
              hint={t('verify.enteredBy', { name: result.enteredByName })}
            />
          ))}
        </fieldset>
        <NoneTicked />
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
        <div>
          <SubmitButton pending={verify.isPending}>
            {verify.isPending ? t('verify.submitting') : t('verify.submit')}
          </SubmitButton>
        </div>
      </Form>
    </section>
  );
}

/** "Tick at least one", under the list, as the form kit gives a field drawn by hand. */
function NoneTicked() {
  const message = useFieldError('ticked');
  return message ? (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  ) : null;
}
