import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Form, SelectField, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { CANCEL_REASONS, cancelSchema, MAX_REASON, type CancelValues } from '../schemas';

/** Cancelling an appointment: a reason from the list, and a note (required for "other"). */
export function CancelForm({
  pending,
  onSubmit,
  onBack,
}: {
  pending: boolean;
  onSubmit: (values: CancelValues) => Promise<void>;
  onBack: () => void;
}) {
  const { t } = useTranslation('appointments');
  const form = useZodForm(cancelSchema, { reason: '', note: '' });
  return (
    <Form form={form} onSubmit={onSubmit}>
      <SelectField<CancelValues>
        name="reason"
        label={t('change.reason')}
        required
        placeholder={t('change.chooseReason')}
        options={CANCEL_REASONS.map((value) => ({
          value,
          label: t(`change.cancelReasons.${value}`),
        }))}
      />
      <TextAreaField<CancelValues>
        name="note"
        label={t('change.note')}
        hint={t('change.noteHint')}
        maxLength={MAX_REASON}
        rows={3}
      />
      <div className="flex flex-wrap gap-2">
        <SubmitButton pending={pending}>
          {pending ? t('change.saving') : t('change.cancel.submit')}
        </SubmitButton>
        <Button
          type="button"
          variant="outline"
          aria-disabled={pending || undefined}
          onClick={onBack}
        >
          {t('change.cancel.back')}
        </Button>
      </div>
    </Form>
  );
}
