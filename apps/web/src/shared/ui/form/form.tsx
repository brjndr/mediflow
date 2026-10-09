/* eslint-disable react-refresh/only-export-components */
import { zodResolver } from '@hookform/resolvers/zod';
import { useId, type ComponentProps, type ReactNode } from 'react';
import {
  FormProvider,
  get,
  useForm,
  useFormContext,
  type DefaultValues,
  type FieldError,
  type FieldValues,
  type Path,
  type UseFormReturn,
} from 'react-hook-form';
import { useTranslation } from 'react-i18next';
import type { z } from 'zod';
import { cn } from '@/shared/lib/utils';
import { Button } from '@/shared/ui/button';

/**
 * The app's form kit: React Hook Form for state, a Zod schema for validation, and fields that
 * take care of labels, error messages and accessibility. A form looks like this:
 *
 *   const schema = z.object({ name: z.string().min(1, 'validation.required') });
 *   const form = useZodForm(schema, { name: '' });
 *   <Form form={form} onSubmit={save}>
 *     <TextField name="name" label={t('patients.name')} />
 *     <SubmitButton pending={saving}>{t('save')}</SubmitButton>
 *   </Form>
 *
 * Validation messages are translation keys. Give a rule a key as its message; rules without one
 * get a generic message for their kind.
 */

export function useZodForm<Input extends FieldValues, Output extends FieldValues>(
  schema: z.ZodType<Output, Input>,
  defaultValues: DefaultValues<Input>,
) {
  return useForm<Input, unknown, Output>({
    resolver: zodResolver(schema),
    defaultValues,
    // Check a field when the user first leaves it, then keep it current as they fix it.
    mode: 'onTouched',
    reValidateMode: 'onChange',
  });
}

interface FormProps<Input extends FieldValues, Output extends FieldValues> {
  form: UseFormReturn<Input, unknown, Output>;
  onSubmit: (values: Output) => void | Promise<void>;
  children: ReactNode;
  className?: string;
}

export function Form<Input extends FieldValues, Output extends FieldValues>({
  form,
  onSubmit,
  children,
  className,
}: FormProps<Input, Output>) {
  return (
    <FormProvider {...form}>
      {/* noValidate: the schema validates, with translated messages, not the browser. */}
      <form
        noValidate
        className={cn('flex flex-col gap-4', className)}
        onSubmit={(event) => void form.handleSubmit(onSubmit)(event)}
      >
        {children}
      </form>
    </FormProvider>
  );
}

/** Messages for Zod's issue kinds, used when a rule has no key of its own. */
const KIND_KEYS: Record<string, string> = {
  invalid_type: 'validation.required',
  too_small: 'validation.too_small',
  too_big: 'validation.too_big',
  invalid_format: 'validation.invalid_format',
  invalid_value: 'validation.invalid_value',
};

/**
 * The translation key for a field error. A rule's own message is used when it is a key that
 * exists; otherwise the kind of rule decides. A message that is not a key is never shown: Zod's
 * built-in messages are English sentences, and a custom one could carry the value entered.
 */
export function fieldErrorKey(error: FieldError, exists: (key: string) => boolean): string {
  if (typeof error.message === 'string' && exists(error.message)) return error.message;
  return KIND_KEYS[String(error.type)] ?? 'validation.invalid';
}

function useField(name: string) {
  const { t, i18n } = useTranslation();
  const form = useFormContext();
  const id = useId();
  const error = get(form.formState.errors, name) as FieldError | undefined;
  const message = error ? t(fieldErrorKey(error, (key) => i18n.exists(key))) : undefined;
  return { form, id, errorId: `${id}-error`, hintId: `${id}-hint`, message };
}

interface FieldProps {
  name: string;
  label: string;
  /** Help text under the label. */
  hint?: string;
  required?: boolean;
}

function FieldShell({
  id,
  errorId,
  hintId,
  label,
  hint,
  required,
  message,
  children,
}: FieldProps & {
  id: string;
  errorId: string;
  hintId: string;
  message: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
        {required && (
          <span aria-hidden className="text-destructive">
            {' *'}
          </span>
        )}
      </label>
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {children}
      {message && (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

const control =
  'w-full rounded-md border bg-background px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive disabled:opacity-50';

/** Ids of the hint and error, so a screen reader reads them with the field. */
const describedBy = (
  hint: string | undefined,
  hintId: string,
  message: string | undefined,
  errorId: string,
) => [hint ? hintId : null, message ? errorId : null].filter(Boolean).join(' ') || undefined;

type InputProps = Omit<ComponentProps<'input'>, 'name' | 'id' | 'required'>;

export function TextField<Values extends FieldValues = FieldValues>({
  name,
  label,
  hint,
  required,
  className,
  ...input
}: FieldProps & InputProps & { name: Path<Values> }) {
  const { form, id, errorId, hintId, message } = useField(name);
  return (
    <FieldShell {...{ id, errorId, hintId, name, label, hint, required, message }}>
      <input
        id={id}
        type="text"
        aria-required={required}
        aria-invalid={message ? true : undefined}
        aria-describedby={describedBy(hint, hintId, message, errorId)}
        className={cn(control, 'h-9', className)}
        {...input}
        {...form.register(name)}
      />
    </FieldShell>
  );
}

type TextAreaProps = Omit<ComponentProps<'textarea'>, 'name' | 'id' | 'required'>;

export function TextAreaField<Values extends FieldValues = FieldValues>({
  name,
  label,
  hint,
  required,
  className,
  ...textarea
}: FieldProps & TextAreaProps & { name: Path<Values> }) {
  const { form, id, errorId, hintId, message } = useField(name);
  return (
    <FieldShell {...{ id, errorId, hintId, name, label, hint, required, message }}>
      <textarea
        id={id}
        rows={4}
        aria-required={required}
        aria-invalid={message ? true : undefined}
        aria-describedby={describedBy(hint, hintId, message, errorId)}
        className={cn(control, 'py-2', className)}
        {...textarea}
        {...form.register(name)}
      />
    </FieldShell>
  );
}

interface SelectOption {
  value: string;
  /** Already translated. */
  label: string;
}

export function SelectField<Values extends FieldValues = FieldValues>({
  name,
  label,
  hint,
  required,
  options,
  placeholder,
}: FieldProps & { name: Path<Values>; options: SelectOption[]; placeholder?: string }) {
  const { form, id, errorId, hintId, message } = useField(name);
  return (
    <FieldShell {...{ id, errorId, hintId, name, label, hint, required, message }}>
      <select
        id={id}
        aria-required={required}
        aria-invalid={message ? true : undefined}
        aria-describedby={describedBy(hint, hintId, message, errorId)}
        className={cn(control, 'h-9')}
        {...form.register(name)}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </FieldShell>
  );
}

export function CheckboxField<Values extends FieldValues = FieldValues>({
  name,
  label,
  hint,
}: Omit<FieldProps, 'required'> & { name: Path<Values> }) {
  const { form, id, errorId, hintId, message } = useField(name);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-start gap-2">
        <input
          id={id}
          type="checkbox"
          className="mt-0.5 size-4"
          aria-invalid={message ? true : undefined}
          aria-describedby={describedBy(hint, hintId, message, errorId)}
          {...form.register(name)}
        />
        <label htmlFor={id} className="text-sm">
          {label}
        </label>
      </div>
      {hint && (
        <p id={hintId} className="pl-6 text-xs text-muted-foreground">
          {hint}
        </p>
      )}
      {message && (
        <p id={errorId} role="alert" className="pl-6 text-sm text-destructive">
          {message}
        </p>
      )}
    </div>
  );
}

/**
 * The form's submit button. It is disabled while the form is submitting or while `pending` is
 * true (a mutation in flight), so a double click cannot send the same thing twice.
 */
export function SubmitButton({
  pending = false,
  children,
  ...button
}: Omit<ComponentProps<typeof Button>, 'type'> & { pending?: boolean }) {
  const { formState } = useFormContext();
  const busy = pending || formState.isSubmitting;
  return (
    <Button type="submit" disabled={busy || button.disabled} aria-busy={busy} {...button}>
      {children}
    </Button>
  );
}
