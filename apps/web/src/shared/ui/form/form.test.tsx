import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { z } from 'zod';
import { expectNoAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import {
  CheckboxField,
  fieldErrorKey,
  Form,
  SelectField,
  SubmitButton,
  TextAreaField,
  TextField,
  useZodForm,
} from '.';

const schema = z.object({
  name: z.string().min(1, 'validation.required'),
  // No message of its own: the generic message for its kind is used.
  email: z.email(),
  age: z.coerce.number().int().min(0).max(130),
  department: z.enum(['cardiology', 'neurology']),
  notes: z.string().max(20).optional(),
  consent: z.literal(true, 'validation.required'),
});

type Values = z.output<typeof schema>;

function Example({
  onSubmit,
  pending = false,
}: {
  onSubmit: (values: Values) => void | Promise<void>;
  pending?: boolean;
}) {
  const form = useZodForm(schema, {
    name: '',
    email: '',
    age: 30,
    department: 'cardiology',
    notes: '',
    consent: false as unknown as true,
  });
  return (
    <main>
      <Form form={form} onSubmit={onSubmit}>
        <TextField name="name" label="Full name" required autoComplete="off" />
        <TextField name="email" label="Email" type="email" hint="Used for appointment letters." />
        <TextField name="age" label="Age" inputMode="numeric" />
        <SelectField
          name="department"
          label="Department"
          options={[
            { value: 'cardiology', label: 'Cardiology' },
            { value: 'neurology', label: 'Neurology' },
          ]}
        />
        <TextAreaField name="notes" label="Notes" />
        <CheckboxField name="consent" label="Consent recorded" />
        <SubmitButton pending={pending}>Save</SubmitButton>
      </Form>
    </main>
  );
}

const field = (name: string) => screen.getByLabelText(new RegExp(`^${name}`));
const fill = async () => {
  await userEvent.type(field('Full name'), 'Test Person');
  await userEvent.type(field('Email'), 'person@example.test');
  await userEvent.click(field('Consent recorded'));
};

describe('form kit', () => {
  it('submits parsed, typed values', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<Example onSubmit={onSubmit} />, { session: null });
    await fill();
    await userEvent.clear(field('Age'));
    await userEvent.type(field('Age'), '42');
    await userEvent.selectOptions(field('Department'), 'neurology');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({
      name: 'Test Person',
      email: 'person@example.test',
      // Coerced to a number by the schema, though the input holds text.
      age: 42,
      department: 'neurology',
      notes: '',
      consent: true,
    });
  });

  it('does not submit invalid values, and shows translated messages', async () => {
    const onSubmit = vi.fn();
    renderWithProviders(<Example onSubmit={onSubmit} />, { session: null });
    await userEvent.type(field('Email'), 'not-an-email');
    await userEvent.clear(field('Age'));
    await userEvent.type(field('Age'), '500');
    await userEvent.type(field('Notes'), 'this note is much longer than twenty characters');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    const alerts = await screen.findAllByRole('alert');
    expect(alerts.map((alert) => alert.textContent)).toEqual([
      // The rule's own key.
      'This field is required.',
      // No key on the rule: the message for its kind.
      'This value is not in the expected format.',
      'This value is too long or too large.',
      'This value is too long or too large.',
      'This field is required.',
    ]);
    expect(onSubmit).not.toHaveBeenCalled();
    // Never the library's untranslated sentence, and never what the user typed.
    expect(document.body).not.toHaveTextContent(/Invalid|Too big|Too small/);
  });

  it('ties each message to its field for assistive technology', async () => {
    renderWithProviders(<Example onSubmit={vi.fn()} />, { session: null });
    const name = field('Full name');
    expect(name).toHaveAttribute('aria-required', 'true');
    expect(name).not.toHaveAttribute('aria-invalid');
    // The hint is read with the field.
    expect(field('Email')).toHaveAccessibleDescription('Used for appointment letters.');

    await userEvent.click(name);
    await userEvent.tab();

    await waitFor(() => expect(name).toHaveAttribute('aria-invalid', 'true'));
    expect(name).toHaveAccessibleDescription('This field is required.');
    await expectNoAxeViolations();

    // Fixing the value clears the error as the user types.
    await userEvent.type(name, 'A');
    await waitFor(() => expect(name).not.toHaveAttribute('aria-invalid'));
    expect(name).not.toHaveAccessibleDescription();
  });

  it('validates a field when the user leaves it, not on every keystroke before that', async () => {
    renderWithProviders(<Example onSubmit={vi.fn()} />, { session: null });
    await userEvent.type(field('Email'), 'half');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await userEvent.tab();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'This value is not in the expected format.',
    );
  });

  describe('submit button', () => {
    it('is disabled while a mutation is pending', async () => {
      renderWithProviders(<Example onSubmit={vi.fn()} pending />, { session: null });
      const button = await screen.findByRole('button', { name: 'Save' });
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('aria-busy', 'true');
    });

    it('is disabled while the form is submitting, so a double click sends once', async () => {
      let finish: () => void = () => {};
      const onSubmit = vi.fn(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      renderWithProviders(<Example onSubmit={onSubmit} />, { session: null });
      await fill();
      const button = screen.getByRole('button', { name: 'Save' });

      await userEvent.dblClick(button);
      await waitFor(() => expect(button).toBeDisabled());
      expect(onSubmit).toHaveBeenCalledTimes(1);

      finish();
      await waitFor(() => expect(button).toBeEnabled());
    });
  });
});

describe('fieldErrorKey', () => {
  const exists = (key: string) => key.startsWith('validation.') || key === 'patients.mrnTaken';

  it('uses the rule’s own message when it is a translation key', () => {
    expect(fieldErrorKey({ type: 'custom', message: 'patients.mrnTaken' }, exists)).toBe(
      'patients.mrnTaken',
    );
  });

  it('never returns a message that is not a key', () => {
    // A built-in English sentence, and a custom message that echoes the input.
    expect(fieldErrorKey({ type: 'too_small', message: 'Too small: expected >=1' }, exists)).toBe(
      'validation.too_small',
    );
    expect(fieldErrorKey({ type: 'custom', message: 'Jane Doe is not allowed' }, exists)).toBe(
      'validation.invalid',
    );
  });

  it('falls back by the kind of rule, then to a generic message', () => {
    expect(fieldErrorKey({ type: 'invalid_type' }, exists)).toBe('validation.required');
    expect(fieldErrorKey({ type: 'invalid_format' }, exists)).toBe('validation.invalid_format');
    expect(fieldErrorKey({ type: 'something_new' }, exists)).toBe('validation.invalid');
  });
});
