import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { CANCEL_REASONS, cancelSchema, MAX_CANCEL_NOTE, type CancelValues } from '../schemas';
import type { QueueCancelReason, QueueToken } from '../types';

/**
 * Takes a waiting or skipped token off the queue for good, with a reason from a list ("other"
 * says why in a note). Part of the page, opened from the token's row: its heading takes focus,
 * and it closes with its own button.
 */
export function CancelPanel({
  token,
  pending,
  onSubmit,
  onBack,
}: {
  token: QueueToken;
  pending: boolean;
  onSubmit: (reason: QueueCancelReason, note: string | undefined) => void;
  onBack: () => void;
}) {
  const { t } = useTranslation('queue');
  const form = useZodForm(cancelSchema, { reason: '', note: '' });
  const other = form.watch('reason') === 'other';
  return (
    <section
      aria-labelledby="queue-cancel-heading"
      className="flex flex-col gap-3 rounded-md border p-4"
    >
      <h2
        id="queue-cancel-heading"
        data-panel-heading
        tabIndex={-1}
        className="rounded-sm text-lg font-semibold outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        {t('cancelPanel.heading', { number: token.number, patient: token.patientName })}
      </h2>
      <p className="text-sm text-muted-foreground">{t('cancelPanel.description')}</p>
      <Form
        form={form}
        onSubmit={(values: CancelValues) => {
          // A note belongs to "other" only: the server refuses it with any other reason.
          if (values.reason !== '') {
            onSubmit(values.reason, values.reason === 'other' ? values.note.trim() : undefined);
          }
        }}
      >
        <SelectField<CancelValues>
          name="reason"
          label={t('cancelPanel.reason')}
          required
          placeholder={t('cancelPanel.chooseReason')}
          options={CANCEL_REASONS.map((value) => ({
            value,
            label: t(`cancelReason.${value}`),
          }))}
        />
        {other && (
          <TextAreaField<CancelValues>
            name="note"
            label={t('cancelPanel.note')}
            hint={t('cancelPanel.noteHint')}
            required
            maxLength={MAX_CANCEL_NOTE}
            rows={2}
          />
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={pending}>{t('cancelPanel.submit')}</SubmitButton>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
            onClick={onBack}
          >
            {t('cancelPanel.back')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
