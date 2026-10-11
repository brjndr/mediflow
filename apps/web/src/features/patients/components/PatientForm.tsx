import { useMemo } from 'react';
import type { DefaultValues } from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import {
  CheckboxField,
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { useTenant } from '@/tenancy';
import { createPatientFormSchema, todayIn, type PatientFormValues } from '../schemas';

interface PatientFormProps {
  /** Receives validated values. The screen decides what happens next. */
  onSubmit: (values: PatientFormValues) => void | Promise<void>;
  pending: boolean;
  /** Values to show again after the user went back from the duplicate warning. */
  initialValues?: PatientFormValues;
}

const EMPTY: DefaultValues<PatientFormValues> = {
  firstName: '',
  lastName: '',
  dob: '',
  phone: '',
  email: '',
  address: '',
  contactConsent: false,
};

export function PatientForm({ onSubmit, pending, initialValues }: PatientFormProps) {
  const { t } = useTranslation('patients');
  const timezone = useTenant()?.timezone ?? 'UTC';
  // A date of birth cannot be after today at the hospital, whatever the browser clock says.
  const schema = useMemo(() => createPatientFormSchema(todayIn(timezone)), [timezone]);
  const form = useZodForm(schema, initialValues ?? EMPTY);

  return (
    <Form form={form} onSubmit={onSubmit} className="max-w-xl">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField name="firstName" label={t('form.firstName')} required autoComplete="off" />
        <TextField name="lastName" label={t('form.lastName')} required autoComplete="off" />
        <TextField name="dob" label={t('form.dob')} type="date" required autoComplete="off" />
        <SelectField
          name="gender"
          label={t('form.gender')}
          required
          placeholder={t('form.genderPlaceholder')}
          options={(['male', 'female', 'other'] as const).map((value) => ({
            value,
            label: t(`gender.${value}`),
          }))}
        />
        <TextField name="phone" label={t('form.phone')} type="tel" required autoComplete="off" />
        <TextField name="email" label={t('form.email')} type="email" autoComplete="off" />
      </div>
      <TextAreaField name="address" label={t('form.address')} rows={3} autoComplete="off" />
      <CheckboxField
        name="contactConsent"
        label={t('form.contactConsent')}
        hint={t('form.contactConsentHint')}
      />
      <SubmitButton pending={pending}>{t('form.submit')}</SubmitButton>
    </Form>
  );
}
