import { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import {
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  useFieldValue,
  useZodForm,
} from '@/shared/ui/form';
import { useRejectSample } from '../hooks/use-lab';
import { REJECT_REASONS, rejectSchema, type RejectOutput, type RejectValues } from '../schemas';
import type { LabSample, LabWorkItem } from '../types';

/** Refusals the person can do nothing about on this form, in words of their own. */
const REFUSED: Record<string, string> = {
  conflict: 'reject.refused.conflict',
  invalid_transition: 'reject.refused.notRejectable',
  sample_not_found: 'reject.refused.gone',
};

/**
 * Rejecting a collected or received sample (#90), with a reason, and a note that `other` needs.
 * The sample stays, rejected, and the order goes back to be collected again. Sent from the
 * version the worklist shows, so a sample that moved meanwhile is refused (409 `conflict`) and
 * the worklist read again. Shown in place, with `data-panel-heading` for the panel's focus.
 */
export function RejectSample({
  item,
  sample,
  onClose,
  onRejected,
}: {
  item: LabWorkItem;
  sample: LabSample;
  onClose: () => void;
  onRejected: (rejected: LabSample) => void;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const reject = useRejectSample();
  const form = useZodForm(rejectSchema, { reason: '', note: '' });

  const submit = async (values: RejectOutput) => {
    reject.reset();
    const note = values.note;
    try {
      const rejected = await reject.mutateAsync({
        sample,
        body: { reason: values.reason, ...(note ? { note } : {}) },
      });
      onRejected(rejected);
    } catch {
      // Said from the mutation state.
    }
  };

  const code = isApiError(reject.error) ? reject.error.serverCode : undefined;
  const failure = reject.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(reject.error))
    : undefined;
  // The sample changed or moved on meanwhile: what this panel would send is refused again, so
  // the button goes and focus goes to what it says. The worklist was read again; closing shows it.
  const refused = code !== undefined && REFUSED[code] !== undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (refused) focusIfLost(alert.current);
  }, [refused]);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('reject.heading', { id: sample.accessionId })}
      </h2>
      <p className="text-sm">{t('reject.of', { test: item.itemName, name: item.patientName })}</p>
      <Form form={form} onSubmit={submit}>
        <SelectField<RejectValues>
          name="reason"
          label={t('reject.reason')}
          required
          placeholder={t('reject.choose')}
          options={REJECT_REASONS.map((reason) => ({
            value: reason,
            label: t(`rejectReason.${reason}`),
          }))}
        />
        <NoteField />
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
            <SubmitButton pending={reject.isPending}>
              {reject.isPending ? t('reject.submitting') : t('reject.submit')}
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

/** The note: required once the reason is `other`, optional otherwise. */
function NoteField() {
  const { t } = useTranslation('lab');
  const reason = useFieldValue('reason');
  return (
    <TextAreaField<RejectValues>
      name="note"
      label={t('reject.note')}
      required={reason === 'other'}
      hint={t('reject.noteHint')}
    />
  );
}
