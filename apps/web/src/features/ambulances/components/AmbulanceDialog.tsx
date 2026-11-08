import { useTranslation } from 'react-i18next';
import { errorMessageKey, isApiError } from '@/shared/api';
import { Button } from '@/shared/ui/button';
import { Dialog } from '@/shared/ui/dialog';
import { Form, SelectField, TextField, useZodForm } from '@/shared/ui/form';
import { useCreateAmbulance } from '../hooks/use-ambulances';
import { ambulanceFormSchema, KINDS, type AmbulanceFormValues } from '../schemas';

/** Adds an ambulance to the fleet. A registration the hospital already has is refused. */
export function AmbulanceDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (registration: string) => void;
}) {
  const { t } = useTranslation('ambulances');
  const { t: tCommon } = useTranslation();
  const create = useCreateAmbulance();
  const form = useZodForm(ambulanceFormSchema, { registration: '', kind: 'basic' });
  const failure = !create.error
    ? undefined
    : isApiError(create.error) && create.error.serverCode === 'duplicate_registration'
      ? t('errors.duplicate')
      : tCommon(errorMessageKey(create.error));

  const submit = async (values: AmbulanceFormValues) => {
    try {
      const made = await create.mutateAsync(values);
      onCreated(made.registration);
    } catch {
      // Said below, from the mutation state.
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(next) => !next && onClose()}
      title={t('add.title')}
      description={t('add.description')}
      closeLabel={t('close')}
      busy={create.isPending}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button type="submit" form="ambulance-form" aria-busy={create.isPending}>
            {create.isPending ? t('add.saving') : t('add.save')}
          </Button>
        </>
      }
    >
      <Form form={form} id="ambulance-form" onSubmit={submit}>
        <TextField<AmbulanceFormValues>
          name="registration"
          label={t('add.registration')}
          required
        />
        <SelectField<AmbulanceFormValues>
          name="kind"
          label={t('add.kind')}
          required
          options={KINDS.map((value) => ({ value, label: t(`kind.${value}`) }))}
        />
        {failure && (
          <p role="alert" className="text-sm text-destructive">
            {failure}
          </p>
        )}
      </Form>
    </Dialog>
  );
}
