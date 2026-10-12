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
  type DoctorFormValues,
} from '../schemas';
import type { Doctor } from '../types';

interface DoctorFormProps {
  /** The profile being changed. Absent to create one. */
  editing?: Doctor;
  pending: boolean;
  /** Already translated. */
  submitLabel: string;
  onSubmit: (values: DoctorFormValues) => void | Promise<void>;
  /** Shown above the fields: the staff picker when creating. */
  before?: ReactNode;
  /** Shown beside the save button: a cancel control. */
  after?: ReactNode;
}

const isMinutes = (value: string): value is DoctorFormValues['consultationMinutes'] =>
  (CONSULTATION_MINUTES as readonly string[]).includes(value);

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
    consultationMinutes: isMinutes(current) ? current : '15',
  });

  const departmentOptions = useMemo(() => {
    const options = (departments.data ?? []).map(({ id, name }) => ({ value: id, label: name }));
    // The doctor's own department stays choosable after it was archived.
    if (editing && !options.some((option) => option.value === editing.departmentId)) {
      options.unshift({ value: editing.departmentId, label: editing.departmentName });
    }
    return options;
  }, [departments.data, editing]);

  const minuteOptions = CONSULTATION_MINUTES.map((value) => ({
    value,
    label: t('minutes', { count: Number(value) }),
  }));

  return (
    <Form form={form} onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4">
      {before}
      {departments.isError && (
        <p role="alert" className="text-sm text-destructive">
          {t('form.departmentsFailed')}
        </p>
      )}
      <SelectField
        // The options arrive after the form: remount so the chosen department shows as chosen.
        key={departmentOptions.length}
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
