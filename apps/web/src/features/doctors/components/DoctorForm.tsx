import type { ReactNode } from 'react';
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useDepartmentOptions } from '@/features/departments';
import { Form, SelectField, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import {
  CONSULTATION_MINUTES,
  doctorFormSchema,
  REGISTRATION_MAX,
  SPECIALIZATION_MAX,
  type DoctorField,
  type DoctorFormValues,
} from '../schemas';
import type { Doctor } from '../types';

interface DoctorFormProps {
  /** The profile being changed. Absent to create one. */
  editing?: Doctor;
  pending: boolean;
  /** Already translated. */
  submitLabel: string;
  /** Receives the values and which fields the person changed from what the form opened with. */
  onSubmit: (values: DoctorFormValues, changed: DoctorField[]) => void | Promise<void>;
  /** Shown above the fields: the staff picker when creating. */
  before?: ReactNode;
  /** Shown beside the save button: a cancel control. */
  after?: ReactNode;
}

/** A doctor's profile fields. One column, so it reads the same on a phone. */
export function DoctorForm({
  editing,
  pending,
  submitLabel,
  onSubmit,
  before,
  after,
}: DoctorFormProps) {
  const { t } = useTranslation('doctors');
  const departments = useDepartmentOptions();
  const current = String(editing?.consultationMinutes ?? 15);
  const form = useZodForm(doctorFormSchema, {
    departmentId: editing?.departmentId ?? '',
    specialization: editing?.specialization ?? '',
    registrationNumber: editing?.registrationNumber ?? '',
    consultationMinutes: current,
  });
  // Read while rendering, which is what keeps it up to date.
  const { dirtyFields } = form.formState;

  const departmentOptions = useMemo(() => {
    const options = (departments.data ?? []).map(({ id, name }) => ({ value: id, label: name }));
    // The doctor's own department stays choosable after it was archived.
    if (editing && !options.some((option) => option.value === editing.departmentId)) {
      options.unshift({ value: editing.departmentId, label: editing.departmentName });
    }
    return options;
  }, [departments.data, editing]);

  // The usual lengths, and the profile's own when it is another one (the API allows 5 to 120).
  const minuteOptions = [...new Set([...CONSULTATION_MINUTES, current])]
    .sort((a, b) => Number(a) - Number(b))
    .map((value) => ({ value, label: t('minutes', { count: Number(value) }) }));

  return (
    <Form
      form={form}
      onSubmit={(values) =>
        onSubmit(
          values,
          (Object.keys(values) as DoctorField[]).filter((field) => dirtyFields[field] === true),
        )
      }
      className="flex max-w-xl flex-col gap-4"
    >
      {before}
      {(departments.isError || !departments.available) && (
        <p role="alert" className="text-sm text-destructive">
          {t(departments.available ? 'form.departmentsFailed' : 'form.departmentsUnavailable')}
        </p>
      )}
      <SelectField
        // The options arrive after the form: remount so the chosen department shows as chosen.
        key={departmentOptions.map((option) => option.value).join(',')}
        name="departmentId"
        label={t('form.department')}
        required
        options={departmentOptions}
        placeholder={t('form.chooseDepartment')}
      />
      <TextField
        name="specialization"
        label={t('form.specialization')}
        hint={t('form.specializationHint')}
        required
        maxLength={SPECIALIZATION_MAX}
      />
      <TextField
        name="registrationNumber"
        label={t('form.registrationNumber')}
        hint={t('form.registrationHint')}
        maxLength={REGISTRATION_MAX}
        autoComplete="off"
      />
      <SelectField
        name="consultationMinutes"
        label={t('form.consultationMinutes')}
        hint={t('form.consultationHint')}
        required
        options={minuteOptions}
      />
      <div className="flex flex-wrap gap-3">
        <SubmitButton pending={pending}>{submitLabel}</SubmitButton>
        {after}
      </div>
    </Form>
  );
}
