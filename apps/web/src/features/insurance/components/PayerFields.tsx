import { useTranslation } from 'react-i18next';
import { TextAreaField, TextField } from '@/shared/ui/form';

/**
 * The fields of a payer that can change, inside a form of the kit. They describe the
 * organisation: a person named here is its contact, never a patient.
 */
export function PayerFields() {
  const { t } = useTranslation('insurance');
  return (
    <>
      <TextField name="name" label={t('form.name')} required maxLength={100} autoComplete="off" />
      <TextField
        name="contactName"
        label={t('form.contactName')}
        hint={t('form.contactHint')}
        maxLength={100}
        autoComplete="off"
      />
      <TextField
        name="phone"
        type="tel"
        label={t('form.phone')}
        maxLength={30}
        autoComplete="off"
      />
      <TextField
        name="email"
        type="email"
        label={t('form.email')}
        maxLength={100}
        autoComplete="off"
      />
      <TextAreaField name="address" label={t('form.address')} maxLength={300} rows={3} />
    </>
  );
}
