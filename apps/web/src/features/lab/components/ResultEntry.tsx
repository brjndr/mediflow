import { useEffect, useId, useLayoutEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import {
  Form,
  SubmitButton,
  TextAreaField,
  TextField,
  useFieldError,
  useZodForm,
} from '@/shared/ui/form';
import { useFormatters } from '@/tenancy';
import { useEnterResults } from '../hooks/use-lab';
import { entrySchema, type EntryOutput, type EntryValues } from '../schemas';
import type { LabAnalyte, LabOrderResults, LabSample } from '../types';
import { rangeWords } from '../range-words';

/** A row per test still to result, keeping what was typed in a row that is still there. */
function rowsFor(analytes: LabAnalyte[], kept: EntryValues['rows']): EntryValues['rows'] {
  return analytes.map(
    (analyte) =>
      kept.find((row) => row.labTestId === analyte.labTestId) ?? {
        labTestId: analyte.labTestId,
        numeric: analyte.resultType === 'numeric',
        value: '',
        comment: '',
      },
  );
}

/**
 * Refusals of an entry, in words of their own. Each reads the page again, which may remount this
 * form, so they are said in the page's status line (`onRefused`), not here.
 */
const REFUSED: Record<string, string> = {
  already_resulted: 'results.refused.alreadyResulted',
  unknown_test: 'results.refused.unknownTest',
  invalid_transition: 'results.refused.notOpen',
  invalid_number: 'results.refused.invalidNumber',
  sample_not_found: 'results.refused.gone',
};

/**
 * Entering results of a received sample (#91, `labResult:enter`): one row per test not yet
 * resulted, with its unit and the patient's range, any of them filled in. A number takes the
 * decimal keyboard and the API's format (`5.10` keeps its decimals, `.5` is refused). One save
 * sends the rows filled in; the flags come back from the API, and a critical one is said aloud.
 * Kept for the sample (`key`): when the tests still to result change (some saved, or someone
 * else entered one meanwhile), the rows follow them and keep what was typed in the others, so
 * nothing already given is asked again.
 */
export function ResultEntry({
  sample,
  analytes,
  onSaved,
  onRefused,
}: {
  sample: LabSample;
  analytes: LabAnalyte[];
  onSaved: (results: LabOrderResults, entered: string[]) => void;
  onRefused: (message: string) => void;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const format = useFormatters();
  const enter = useEnterResults(sample.orderId);
  const headingId = useId();
  const form = useZodForm(entrySchema, { rows: rowsFor(analytes, []) });
  const tests = analytes.map((analyte) => analyte.labTestId).join();
  const shown = useRef(tests);
  useLayoutEffect(() => {
    if (shown.current === tests) return;
    shown.current = tests;
    form.reset({ rows: rowsFor(analytes, form.getValues().rows) });
  }, [tests, analytes, form]);

  const submit = async (values: EntryOutput) => {
    enter.reset();
    const results = values.rows
      .filter((row) => row.value)
      .map((row) => ({
        labTestId: row.labTestId,
        value: row.value,
        ...(row.comment ? { comment: row.comment } : {}),
      }));
    try {
      const answer = await enter.mutateAsync({ sampleId: sample.id, results });
      onSaved(
        answer,
        results.map((each) => each.labTestId),
      );
    } catch (error) {
      const key = isApiError(error) ? REFUSED[error.serverCode ?? ''] : undefined;
      if (key) onRefused(t(key));
    }
  };

  // Anything else (offline, a server error) stays here, with what was typed, to send again.
  const code = isApiError(enter.error) ? enter.error.serverCode : undefined;
  const failure =
    enter.error && !(code !== undefined && REFUSED[code])
      ? tCommon(errorMessageKey(enter.error))
      : undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (failure) focusIfLost(alert.current);
  }, [failure]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} className="font-semibold">
        {t('results.enterHeading')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('results.enterHint')}</p>
      <Form form={form} onSubmit={submit}>
        {analytes.map((analyte, index) => {
          const range = rangeWords(analyte.range, t, (value) => format.number(value));
          const label = analyte.unit
            ? t('results.valueWithUnit', { name: analyte.name, unit: analyte.unit })
            : analyte.name;
          const hint = range ? t('results.rangeHint', { range }) : undefined;
          return (
            <div
              key={analyte.labTestId}
              className="flex flex-col gap-2 border-b pb-3 last:border-b-0"
            >
              {analyte.resultType === 'numeric' ? (
                <TextField<EntryValues>
                  name={`rows.${index}.value`}
                  label={label}
                  hint={hint}
                  inputMode="decimal"
                  autoComplete="off"
                  className="md:max-w-48"
                />
              ) : (
                <TextAreaField<EntryValues>
                  name={`rows.${index}.value`}
                  label={label}
                  hint={hint}
                  rows={2}
                />
              )}
              <CommentDetails index={index}>
                <summary className="w-fit cursor-pointer rounded-sm py-1 outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:py-3">
                  {t('results.addComment', { name: analyte.name })}
                </summary>
                <div className="pt-2">
                  <TextAreaField<EntryValues>
                    name={`rows.${index}.comment`}
                    label={t('results.comment', { name: analyte.name })}
                    rows={2}
                  />
                </div>
              </CommentDetails>
            </div>
          );
        })}
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
          <SubmitButton pending={enter.isPending}>
            {enter.isPending ? t('results.saving') : t('results.save')}
          </SubmitButton>
        </div>
      </Form>
    </section>
  );
}

/** A comment behind "Add a comment", opened when its field has an error, so it can take focus. */
function CommentDetails({ index, children }: { index: number; children: ReactNode }) {
  const error = useFieldError(`rows.${index}.comment`);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (error && details.current) details.current.open = true;
  }, [error]);
  return (
    <details ref={details} className="text-sm">
      {children}
    </details>
  );
}
