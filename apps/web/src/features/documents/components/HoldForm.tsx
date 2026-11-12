import { useTranslation } from 'react-i18next';
import { errorMessageKey } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextAreaField, useZodForm } from '@/shared/ui/form';
import { usePlaceHold } from '../hooks/use-holds';
import { holdFormSchema, type HoldValues } from '../schemas';
import type { LegalHold } from '../types';

/**
 * Places a legal hold (#628) on one document, or on every document of the patient (those added
 * later too). The retention sweep leaves held documents alone until the hold is released.
 */
export function HoldForm({
  patientId,
  document,
  onClose,
  onPlaced,
}: {
  patientId: string;
  document?: { id: string; title: string };
  onClose: () => void;
  onPlaced: (hold: LegalHold) => void;
}) {
  const { t } = useTranslation('documents');
  const { t: tCommon } = useTranslation();
  const place = usePlaceHold();
  const form = useZodForm(holdFormSchema, { reason: '' });

  const submit = async (values: HoldValues) => {
    place.reset();
    try {
      onPlaced(
        await place.mutateAsync({
          target: { patientId, documentId: document?.id },
          reason: values.reason,
        }),
      );
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <h3 data-panel-heading tabIndex={-1} className="font-semibold outline-none">
        {document ? t('hold.heading', { title: document.title }) : t('hold.headingPatient')}
      </h3>
      <p className="text-sm text-muted-foreground">
        {document ? t('hold.note') : t('hold.notePatient')}
      </p>
      <Form form={form} onSubmit={submit} className="max-w-xl">
        <TextAreaField<HoldValues> name="reason" label={t('hold.reason')} required />
        {place.error && (
          <p role="alert" className="text-sm text-destructive">
            {tCommon(errorMessageKey(place.error))}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <SubmitButton pending={place.isPending}>
            {place.isPending ? t('hold.submitting') : t('hold.submit')}
          </SubmitButton>
          <Button type="button" variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </div>
      </Form>
    </div>
  );
}
