/* eslint-disable @typescript-eslint/no-unnecessary-condition -- left-joined rows can be undefined at runtime when a patient/doctor is missing */
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { eq, useLiveQuery } from '@tanstack/react-db'

import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardTitle } from '#/components/ui/card'
import { Select } from '#/components/ui/select'
import { useAppForm } from '#/hooks/demo.form'
import { getCollections } from '#/lib/hospital/collections'
import {
  APPOINTMENT_STATUSES,
  appointmentInputSchema,
  appointmentStatusTone,
  fullName,
} from '#/lib/hospital/schemas'
import type { AppointmentStatus } from '#/lib/hospital/schemas'

export const Route = createFileRoute('/appointments')({
  // TanStack DB collections are client-only: disable SSR for this route.
  ssr: false,
  loader: async ({ context }) => {
    const c = getCollections(context.queryClient)
    await Promise.all([
      c.patients.preload(),
      c.doctors.preload(),
      c.appointments.preload(),
    ])
    return null
  },
  component: AppointmentsPage,
})

function AppointmentsPage() {
  const queryClient = useQueryClient()
  const { patients, doctors, appointments } = getCollections(queryClient)
  const [filter, setFilter] = useState<AppointmentStatus | ''>('')

  // Live, incrementally-maintained join across three collections.
  const { data: board } = useLiveQuery({
    query: (q) => {
      const base = q
        .from({ a: appointments })
        .join({ p: patients }, ({ a, p }) => eq(a.patientId, p.id), 'left')
        .join({ d: doctors }, ({ a, d }) => eq(a.doctorId, d.id), 'left')
      const filtered = filter
        ? base.where(({ a }) => eq(a.status, filter))
        : base
      return filtered
        .orderBy(({ a }) => a.scheduledAt, 'asc')
        .select(({ a, p, d }) => ({
          id: a.id,
          scheduledAt: a.scheduledAt,
          reason: a.reason,
          status: a.status,
          firstName: p?.firstName,
          lastName: p?.lastName,
          doctor: d?.name,
          specialty: d?.specialty,
        }))
    },
  })
  const { data: patientOptions } = useLiveQuery({
    query: (q) => q.from({ p: patients }).orderBy(({ p }) => p.lastName, 'asc'),
  })
  const { data: doctorOptions } = useLiveQuery({
    query: (q) => q.from({ d: doctors }).orderBy(({ d }) => d.name, 'asc'),
  })

  const setStatus = (id: string, status: AppointmentStatus) => {
    appointments.update(id, (draft) => {
      draft.status = status
    })
  }

  const form = useAppForm({
    defaultValues: { patientId: '', doctorId: '', scheduledAt: '', reason: '' },
    validators: { onChange: appointmentInputSchema },
    onSubmit: ({ value, formApi }) => {
      appointments.insert({
        ...appointmentInputSchema.parse(value),
        id: `tmp_${crypto.randomUUID()}`,
        status: 'SCHEDULED',
        scheduledAt: new Date(value.scheduledAt).toISOString(),
      })
      formApi.reset()
    },
  })

  return (
    <main className="page-wrap px-4 pb-8 pt-10">
      <p className="island-kicker mb-1">Scheduling · TanStack DB</p>
      <h1 className="display-title mb-6 text-3xl font-bold text-[var(--sea-ink)]">
        Appointments
      </h1>

      <div className="grid gap-4 lg:grid-cols-[1fr_20rem]">
        <div>
          <div className="mb-3 flex items-center gap-3">
            <Select
              aria-label="Filter by status"
              className="w-48"
              value={filter}
              onChange={(e) =>
                setFilter(e.target.value as AppointmentStatus | '')
              }
            >
              <option value="">All statuses</option>
              {APPOINTMENT_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
            <span className="text-sm text-[var(--sea-ink-soft)]">
              {board.length} shown
            </span>
          </div>

          <ul className="m-0 grid list-none gap-2 p-0">
            {board.map((a) => (
              <li
                key={a.id}
                className="island-shell flex flex-wrap items-center justify-between gap-3 rounded-xl px-4 py-3 text-sm"
              >
                <div>
                  <strong>
                    {a.firstName
                      ? fullName({
                          firstName: a.firstName,
                          lastName: a.lastName ?? '',
                        })
                      : 'Unknown patient'}
                  </strong>
                  <div className="text-[var(--sea-ink-soft)]">
                    {new Date(a.scheduledAt).toLocaleString([], {
                      dateStyle: 'medium',
                      timeStyle: 'short',
                    })}
                    {' · '}
                    {a.doctor ?? 'Unassigned'} ({a.specialty ?? '—'}) ·{' '}
                    {a.reason}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={appointmentStatusTone[a.status]}>
                    {a.status}
                  </Badge>
                  {a.status === 'SCHEDULED' && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setStatus(a.id, 'CHECKED_IN')}
                    >
                      Check in
                    </Button>
                  )}
                  {a.status === 'CHECKED_IN' && (
                    <Button
                      size="sm"
                      onClick={() => setStatus(a.id, 'COMPLETED')}
                    >
                      Complete
                    </Button>
                  )}
                  {(a.status === 'SCHEDULED' || a.status === 'CHECKED_IN') && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setStatus(a.id, 'CANCELLED')}
                    >
                      Cancel
                    </Button>
                  )}
                </div>
              </li>
            ))}
            {board.length === 0 && (
              <li className="p-6 text-center text-sm text-[var(--sea-ink-soft)]">
                No appointments.
              </li>
            )}
          </ul>
        </div>

        <Card className="h-fit">
          <CardTitle>Book appointment</CardTitle>
          <form
            className="grid gap-3"
            onSubmit={(e) => {
              e.preventDefault()
              void form.handleSubmit()
            }}
          >
            <form.AppField name="patientId">
              {(field) => (
                <field.Select
                  label="Patient"
                  placeholder="Select patient"
                  values={patientOptions.map((p) => ({
                    label: `${fullName(p)} (${p.mrn})`,
                    value: p.id,
                  }))}
                />
              )}
            </form.AppField>
            <form.AppField name="doctorId">
              {(field) => (
                <field.Select
                  label="Doctor"
                  placeholder="Select doctor"
                  values={doctorOptions.map((d) => ({
                    label: `${d.name} — ${d.specialty}`,
                    value: d.id,
                  }))}
                />
              )}
            </form.AppField>
            <form.AppField name="scheduledAt">
              {(field) => (
                <field.TextField label="When" type="datetime-local" />
              )}
            </form.AppField>
            <form.AppField name="reason">
              {(field) => <field.TextField label="Reason" />}
            </form.AppField>
            <form.AppForm>
              <form.SubscribeButton label="Book" />
            </form.AppForm>
          </form>
        </Card>
      </div>
    </main>
  )
}
