import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { useRetireDocument } from '../hooks/use-documents';
import { retireFormSchema, type RetireValues } from '../schemas';
import type { PatientDocument } from '../types';

const REFUSED: Record<string, string> = {
  conflict: 'retire.errors.conflict',
  already_retired: 'retire.errors.already',
  document_not_found: 'retire.errors.gone',
};

/**
 * Retires a document with a reason (#189). Nothing deletes a document: it stays on the record,
 * kept for its retention, and leaves the default list. Sent at the version read.
 */
export function RetireForm({
  document,
  onClose,
  onRetired,
}: {
  document: PatientDocument;
  onClose: () => void;
  onRetired: (document: PatientDocument) => void;
}) {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const retire = useRetireDocument();
  const form = useZodForm(retireFormSchema, { reason: '' });

  const submit = async (values: RetireValues) => {
    retire.reset();
    try {
      onRetired(await retire.mutateAsync({ document, reason: values.reason }));
    } catch {
      // Said below, from the mutation state.
    }
  };

  const code = isApiError(retire.error) ? retire.error.serverCode : undefined;
  const failure = retire.error
    ? code !== undefined && REFUSED[code]
      ? t(REFUSED[code])
      : tCommon(errorMessageKey(retire.error))
    : undefined;

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {t('retire.heading', { title: document.title })}
      </h3>
      <p className="text-sm text-muted-foreground">{t('retire.note')}</p>
      <Form form={form} onSubmit={submit} className="max-w-xl">
        <TextAreaField<RetireValues> name="reason" label={t('retire.reason')} required />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={retire.isPending}>
            {retire.isPending ? t('retire.submitting') : t('retire.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
