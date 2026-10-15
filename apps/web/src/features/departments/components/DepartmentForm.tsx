import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextAreaField, TextField, useZodForm } from '@/shared/ui/form';
import {
  departmentFormSchema,
  DESCRIPTION_MAX,
  NAME_MAX,
  type DepartmentFormValues,
} from '../schemas';
import type { Department } from '../types';

interface DepartmentFormProps {
  /** The department being changed. Absent to add one. */
  editing?: Department;
  pending: boolean;
  /** Already translated. Why the last save was refused. */
  error?: string;
  onSubmit: (values: DepartmentFormValues) => void | Promise<void>;
  onCancel: () => void;
}

/** Adds a department or changes one. One column, so it reads the same on a phone. */
export function DepartmentForm({
  editing,
  pending,
  error,
  onSubmit,
  onCancel,
}: DepartmentFormProps) {
  const { t } = useTranslation('departments');
  const form = useZodForm(departmentFormSchema, {
    name: editing?.name ?? '',
    description: editing?.description ?? '',
  });
  const headingId = 'department-form-heading';
  const { setFocus } = form;

  // The form opens above the list, away from the button that opened it: take the keyboard there.
  useEffect(() => setFocus('name'), [setFocus]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {editing ? t('form.editHeading', { name: editing.name }) : t('form.addHeading')}
      </h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Form form={form} onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4">
        <TextField name="name" label={t('form.name')} required maxLength={NAME_MAX} />
        <TextAreaField
          name="description"
          label={t('form.description')}
          hint={t('form.descriptionHint')}
          maxLength={DESCRIPTION_MAX}
          rows={3}
        />
        <div className="flex flex-wrap gap-3">
          <SubmitButton pending={pending}>{t('form.save')}</SubmitButton>
          <Button
            type="button"
            variant="outline"
            aria-disabled={pending || undefined}
            onClick={onCancel}
          >
            {t('form.cancel')}
          </Button>
        </div>
      </Form>
    </section>
  );
}
