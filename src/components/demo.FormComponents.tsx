import { useStore } from '@tanstack/react-form'

import { useFieldContext, useFormContext } from '#/hooks/demo.form-context'

import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Textarea as ShadcnTextarea } from '#/components/ui/textarea'
import { Select as ShadcnSelect } from '#/components/ui/select'
import { Label } from '#/components/ui/label'

export function SubscribeButton({ label }: { label: string }) {
  const form = useFormContext()
  return (
    <form.Subscribe selector={(state) => state.isSubmitting}>
      {(isSubmitting) => (
        <Button type="submit" disabled={isSubmitting}>
          {label}
        </Button>
      )}
    </form.Subscribe>
  )
}

function ErrorMessages({
  errors,
}: {
  errors: Array<string | { message: string }>
}) {
  return (
    <>
      {errors.map((error) => (
        <div
          key={typeof error === 'string' ? error : error.message}
          className="mt-1 text-sm font-semibold text-red-600"
        >
          {typeof error === 'string' ? error : error.message}
        </div>
      ))}
    </>
  )
}

export function TextField({
  label,
  placeholder,
  type = 'text',
}: {
  label: string
  placeholder?: string
  type?: React.HTMLInputTypeAttribute
}) {
  const field = useFieldContext<string>()
  const errors = useStore(field.store, (state) => state.meta.errors)

  return (
    <div>
      <Label
        htmlFor={label}
        className="mb-2 text-sm font-semibold text-[var(--sea-ink)]"
      >
        {label}
      </Label>
      <Input
        id={label}
        type={type}
        value={field.state.value}
        placeholder={placeholder}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
      />
      {field.state.meta.isTouched && <ErrorMessages errors={errors} />}
    </div>
  )
}

export function TextArea({
  label,
  rows = 3,
}: {
  label: string
  rows?: number
}) {
  const field = useFieldContext<string>()
  const errors = useStore(field.store, (state) => state.meta.errors)

  return (
    <div>
      <Label
        htmlFor={label}
        className="mb-2 text-sm font-semibold text-[var(--sea-ink)]"
      >
        {label}
      </Label>
      <ShadcnTextarea
        id={label}
        value={field.state.value}
        onBlur={field.handleBlur}
        rows={rows}
        onChange={(e) => field.handleChange(e.target.value)}
      />
      {field.state.meta.isTouched && <ErrorMessages errors={errors} />}
    </div>
  )
}

export function Select({
  label,
  values,
  placeholder,
}: {
  label: string
  values: Array<{ label: string; value: string }>
  placeholder?: string
}) {
  const field = useFieldContext<string>()
  const errors = useStore(field.store, (state) => state.meta.errors)

  return (
    <div>
      <Label
        htmlFor={field.name}
        className="mb-2 text-sm font-semibold text-[var(--sea-ink)]"
      >
        {label}
      </Label>
      <ShadcnSelect
        id={field.name}
        name={field.name}
        value={field.state.value}
        onBlur={field.handleBlur}
        onChange={(e) => field.handleChange(e.target.value)}
      >
        <option value="">{placeholder ?? 'Select…'}</option>
        {values.map((value) => (
          <option key={value.value} value={value.value}>
            {value.label}
          </option>
        ))}
      </ShadcnSelect>
      {field.state.meta.isTouched && <ErrorMessages errors={errors} />}
    </div>
  )
}
