import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/shared/ui/button';
import { Form, SubmitButton, TextField, useZodForm } from '@/shared/ui/form';
import { NAME_MAX, roleFormSchema, type RoleFormValues } from '../schemas';
import type { RoleSummary } from '../types';

interface RoleFormProps {
  /** The role being renamed. Absent to add one. */
  editing?: RoleSummary;
  pending: boolean;
  /** Already translated. Why the last save was refused. */
  error?: string;
  onSubmit: (values: RoleFormValues) => void | Promise<void>;
  onCancel: () => void;
}

/** Adds a custom role or renames one. */
export function RoleForm({ editing, pending, error, onSubmit, onCancel }: RoleFormProps) {
  const { t } = useTranslation('roles');
  const form = useZodForm(roleFormSchema, { name: editing?.name ?? '' });
  const headingId = 'role-form-heading';
  const { setFocus } = form;

  // The form opens above the list, away from the button that opened it: take the keyboard there.
  useEffect(() => setFocus('name'), [setFocus]);

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3 rounded-lg border p-4">
      <h2 id={headingId} className="text-lg font-semibold">
        {editing ? t('form.renameHeading', { name: editing.name }) : t('form.addHeading')}
      </h2>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Form form={form} onSubmit={onSubmit} className="flex max-w-xl flex-col gap-4">
        <TextField
          name="name"
          label={t('form.name')}
          hint={editing ? undefined : t('form.nameHint')}
          required
          maxLength={NAME_MAX}
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
