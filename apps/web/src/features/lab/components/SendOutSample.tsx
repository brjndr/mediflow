import { useId, useLayoutEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { focusIfLost } from '@/shared/lib/focus';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { useSendOutSample } from '../hooks/use-lab';
import { sendOutSchema, type SendOutOutput, type SendOutValues } from '../schemas';
import type { LabSample, LabWorkItem } from '../types';

/** Refusals the person can do nothing about on this form, in words of their own. */
const REFUSED: Record<string, string> = {
  conflict: 'sendOut.refused.conflict',
  invalid_transition: 'sendOut.refused.notSendable',
  has_results: 'sendOut.refused.hasResults',
  sample_not_found: 'sendOut.refused.gone',
};

/**
 * Sending a received sample to a partner laboratory (#94): the partner by name, and its own
 * number for the sample when it gives one. The sample waits at the stage "With partner lab" until
 * its report is back, and takes no results meanwhile. Sent from the version the worklist shows,
 * as rejecting is. Shown in place, with `data-panel-heading` for the panel's focus.
 */
export function SendOutSample({
  item,
  sample,
  onClose,
  onSent,
}: {
  item: LabWorkItem;
  sample: LabSample;
  onClose: () => void;
  onSent: (sent: LabSample) => void;
}) {
  const { t } = useTranslation('lab');
  const { t: tCommon } = useTranslation();
  const sendOut = useSendOutSample();
  const form = useZodForm(sendOutSchema, { partnerLab: '', partnerRef: '' });

  const submit = async (values: SendOutOutput) => {
    sendOut.reset();
    try {
      const sent = await sendOut.mutateAsync({
        sample,
        body: {
          partnerLab: values.partnerLab,
          ...(values.partnerRef ? { partnerRef: values.partnerRef } : {}),
        },
      });
      onSent(sent);
    } catch {
      // Said from the mutation state.
    }
  };

  const code = isApiError(sendOut.error) ? sendOut.error.serverCode : undefined;
  const failure = sendOut.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(sendOut.error))
    : undefined;
  // What this panel would send is refused again: the button goes and focus goes to the alert.
  const refused = code !== undefined && REFUSED[code] !== undefined;
  const alert = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    if (refused) focusIfLost(alert.current);
  }, [refused]);
  const headingId = useId();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-md border p-3">
      <h2 id={headingId} data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('sendOut.heading', { id: sample.accessionId })}
      </h2>
      <p className="text-sm">{t('sendOut.of', { test: item.itemName, name: item.patientName })}</p>
      <Form form={form} onSubmit={submit}>
        <TextField<SendOutValues>
          name="partnerLab"
          label={t('sendOut.partnerLab')}
          required
          autoComplete="organization"
        />
        <TextField<SendOutValues>
          name="partnerRef"
          label={t('sendOut.partnerRef')}
          hint={t('sendOut.partnerRefHint')}
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
            <SubmitButton pending={sendOut.isPending}>
              {sendOut.isPending ? t('sendOut.submitting') : t('sendOut.submit')}
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
