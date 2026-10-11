import { useEffect, useMemo } from 'react';
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
  /** Values to show again after the user went back from the duplicate warning, or to edit. */
  initialValues?: PatientFormValues;
  /** False for a role that may not see contact details: no phone, email or address fields. */
  withContact?: boolean;
  /** A line under a field, e.g. what someone else saved there meanwhile. */
  hints?: PatientFormHints;
  /** Already translated. "Register patient" when not given. */
  submitLabel?: string;
  /** Called as the person types, with what the form holds (not yet checked). */
  onValuesChange?: (values: Partial<PatientFormValues>) => void;
}

export type PatientFormHints = Partial<Record<keyof PatientFormValues, string>>;

const EMPTY: DefaultValues<PatientFormValues> = {
  firstName: '',
  lastName: '',
  dob: '',
  phone: '',
  email: '',
  address: '',
  contactConsent: false,
};

export function PatientForm({
  onSubmit,
  pending,
  initialValues,
  withContact = true,
  hints = {},
  submitLabel,
  onValuesChange,
}: PatientFormProps) {
  const { t } = useTranslation('patients');
  const timezone = useTenant()?.timezone ?? 'UTC';
  // A date of birth cannot be after today at the hospital, whatever the browser clock says.
  const schema = useMemo(
    () => createPatientFormSchema(todayIn(timezone), { contact: withContact }),
    [timezone, withContact],
  );
  const form = useZodForm(schema, initialValues ?? EMPTY);

  useEffect(() => {
    if (!onValuesChange) return;
    const subscription = form.watch((values) => onValuesChange(values));
    return () => subscription.unsubscribe();
  }, [form, onValuesChange]);

  return (
    <Form form={form} onSubmit={onSubmit} className="max-w-xl">
      <div className="grid gap-4 sm:grid-cols-2">
        <TextField
          name="firstName"
          label={t('form.firstName')}
          hint={hints.firstName}
          required
          autoComplete="off"
        />
        <TextField
          name="lastName"
          label={t('form.lastName')}
          hint={hints.lastName}
          required
          autoComplete="off"
        />
        <TextField
          name="dob"
          label={t('form.dob')}
          hint={hints.dob}
          type="date"
          required
          autoComplete="off"
        />
        <SelectField
          name="gender"
          label={t('form.gender')}
          hint={hints.gender}
          required
          placeholder={t('form.genderPlaceholder')}
          options={(['male', 'female', 'other'] as const).map((value) => ({
            value,
            label: t(`gender.${value}`),
          }))}
        />
        {withContact && (
          <>
            <TextField
              name="phone"
              label={t('form.phone')}
              hint={hints.phone}
              type="tel"
              required
              autoComplete="off"
            />
            <TextField
              name="email"
              label={t('form.email')}
              hint={hints.email}
              type="email"
              autoComplete="off"
            />
          </>
        )}
      </div>
      {withContact && (
        <TextAreaField
          name="address"
          label={t('form.address')}
          hint={hints.address}
          rows={3}
          autoComplete="off"
        />
      )}
      <CheckboxField
        name="contactConsent"
        label={t('form.contactConsent')}
        hint={hints.contactConsent ?? t('form.contactConsentHint')}
      />
      <SubmitButton pending={pending}>{submitLabel ?? t('form.submit')}</SubmitButton>
    </Form>
  );
}
