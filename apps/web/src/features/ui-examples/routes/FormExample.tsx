import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { z } from 'zod';
import {
  CheckboxField,
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '@/shared/ui/form';
import { ExamplePage } from '../components/ExamplePage';

const DEPARTMENTS = ['cardiology', 'neurology', 'orthopaedics', 'paediatrics'] as const;

// Validation messages are translation keys. Rules without one get the message for their kind.
const schema = z.object({
  name: z.string().trim().min(1, 'validation.required').max(120),
  email: z.email(),
  age: z.coerce.number().int().min(0).max(130),
  department: z.enum(DEPARTMENTS, 'validation.required'),
  notes: z.string().max(500).optional(),
  consent: z.literal(true, 'validation.required'),
});

type Values = z.output<typeof schema>;

export default function FormExample() {
  const { t } = useTranslation('ui_examples');
  const [submitted, setSubmitted] = useState<Values>();
  const form = useZodForm(schema, {
    name: '',
    email: '',
    age: 30,
    department: '' as unknown as Values['department'],
    notes: '',
    consent: false as unknown as true,
  });

  return (
    <ExamplePage heading={t('form.heading')}>
      <Form form={form} onSubmit={setSubmitted} className="max-w-md">
        <TextField name="name" label={t('form.name')} required autoComplete="off" />
        <TextField
          name="email"
          label={t('form.email')}
          type="email"
          hint={t('form.emailHint')}
          required
        />
        <TextField name="age" label={t('form.age')} inputMode="numeric" />
        <SelectField
          name="department"
          label={t('form.department')}
          required
          placeholder={t('form.departmentPlaceholder')}
          options={DEPARTMENTS.map((value) => ({ value, label: t(`departments.${value}`) }))}
        />
        <TextAreaField name="notes" label={t('form.notes')} />
        <CheckboxField name="consent" label={t('form.consent')} />
        <SubmitButton className="self-start">{t('form.save')}</SubmitButton>
      </Form>
      {submitted && (
        <section aria-labelledby="submitted-title" className="rounded-lg border p-4">
          <h2 id="submitted-title" className="mb-2 text-sm font-medium">
            {t('form.submitted')}
          </h2>
          <pre className="overflow-x-auto text-xs">{JSON.stringify(submitted, null, 2)}</pre>
        </section>
      )}
    </ExamplePage>
  );
}
