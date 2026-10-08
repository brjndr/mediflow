import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useHotkey } from '@tanstack/react-hotkeys'

import { useAppForm } from '#/hooks/demo.form'
import { hospitalKeys } from '#/lib/hospital/queries'
import {
  GENDERS,
  PATIENT_STATUSES,
  WARDS,
  patientInputSchema,
} from '#/lib/hospital/schemas'
import type { PatientInput } from '#/lib/hospital/schemas'
import { createPatient } from '#/server/hospital.functions'

export const Route = createFileRoute('/patients/new')({
  component: NewPatientPage,
})

const options = (values: ReadonlyArray<string>) =>
  values.map((v) => ({ label: v, value: v }))

function NewPatientPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const create = useMutation({
    mutationFn: (data: PatientInput) => createPatient({ data }),
    onSuccess: async (patient) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: hospitalKeys.patients }),
        queryClient.invalidateQueries({ queryKey: hospitalKeys.stats }),
      ])
      await navigate({
        to: '/patients/$patientId',
        params: { patientId: patient.id },
      })
    },
  })

  const form = useAppForm({
    defaultValues: {
      firstName: '',
      lastName: '',
      dateOfBirth: '',
      gender: '',
      phone: '',
      ward: '',
      status: 'ADMITTED',
      condition: '',
    },
    // Same zod schema the server function validates with.
    validators: { onChange: patientInputSchema, onSubmit: patientInputSchema },
    onSubmit: async ({ value }) => {
      await create.mutateAsync(patientInputSchema.parse(value))
    },
  })

  // Mod+Enter submits even while typing in a field (Mod combos are not
  // suppressed inside inputs by TanStack Hotkeys).
  useHotkey('Mod+Enter', () => void form.handleSubmit())

  return (
    <main className="page-wrap px-4 pb-8 pt-10">
      <p className="island-kicker mb-1">Registry</p>
      <h1 className="display-title mb-6 text-3xl font-bold text-[var(--sea-ink)]">
        Register patient
      </h1>

      <form
        className="island-shell grid max-w-2xl gap-4 rounded-2xl p-6 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault()
          e.stopPropagation()
          void form.handleSubmit()
        }}
      >
        <form.AppField name="firstName">
          {(field) => <field.TextField label="First name" />}
        </form.AppField>
        <form.AppField name="lastName">
          {(field) => <field.TextField label="Last name" />}
        </form.AppField>
        <form.AppField name="dateOfBirth">
          {(field) => <field.TextField label="Date of birth" type="date" />}
        </form.AppField>
        <form.AppField name="gender">
          {(field) => (
            <field.Select
              label="Gender"
              values={options(GENDERS)}
              placeholder="Select gender"
            />
          )}
        </form.AppField>
        <form.AppField name="phone">
          {(field) => (
            <field.TextField label="Phone" placeholder="+1 555 0100" />
          )}
        </form.AppField>
        <form.AppField name="ward">
          {(field) => (
            <field.Select
              label="Ward"
              values={options(WARDS)}
              placeholder="Select ward"
            />
          )}
        </form.AppField>
        <form.AppField name="status">
          {(field) => (
            <field.Select label="Status" values={options(PATIENT_STATUSES)} />
          )}
        </form.AppField>
        <div className="sm:col-span-2">
          <form.AppField name="condition">
            {(field) => <field.TextArea label="Condition / reason for visit" />}
          </form.AppField>
        </div>

        {create.isError && (
          <p
            role="alert"
            className="m-0 text-sm font-semibold text-red-600 sm:col-span-2"
          >
            {create.error.message}
          </p>
        )}

        <div className="flex items-center gap-3 sm:col-span-2">
          <form.AppForm>
            <form.SubscribeButton label="Register patient" />
          </form.AppForm>
          <span className="text-xs text-[var(--sea-ink-soft)]">
            or press Ctrl/⌘ + Enter
          </span>
        </div>
      </form>
    </main>
  )
}
