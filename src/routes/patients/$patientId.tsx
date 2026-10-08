import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import { useMutation, useSuspenseQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { Check } from 'lucide-react'

import PatientStatusBadge from '#/components/PatientStatusBadge'
import StageBadge from '#/components/StageBadge'
import { Badge } from '#/components/ui/badge'
import { Button } from '#/components/ui/button'
import { Card, CardDescription, CardTitle } from '#/components/ui/card'
import { Input } from '#/components/ui/input'
import { Select } from '#/components/ui/select'
import { useAppForm } from '#/hooks/demo.form'
import { generatePatientLabs } from '#/lib/hospital/lab-records'
import { appointmentsQuery, chartQuery } from '#/lib/hospital/queries'
import {
  NOTE_KINDS,
  fullName,
  noteInputSchema,
  vitalsFormSchema,
} from '#/lib/hospital/schemas'
import type { NoteKind, PatientStatus } from '#/lib/hospital/schemas'
import { useInvalidatePatientData } from '#/lib/hospital/use-invalidate'
import {
  STAGES,
  STAGE_LABEL,
  TRANSITIONS,
  checkTransition,
} from '#/lib/hospital/workflow'
import type { Stage } from '#/lib/hospital/workflow'
import {
  addClinicalNote,
  addVitals,
  transitionPatientStage,
  updatePatientStatus,
} from '#/server/hospital.functions'

export const Route = createFileRoute('/patients/$patientId')({
  loader: async ({ context, params }) => {
    const chart = await context.queryClient.ensureQueryData(
      chartQuery(params.patientId),
    )
    if (!chart) throw notFound()
    await context.queryClient.ensureQueryData(appointmentsQuery())
  },
  notFoundComponent: () => (
    <main className="page-wrap px-4 pt-10">
      <p>Patient not found.</p>
      <Link to="/patients">Back to patients</Link>
    </main>
  ),
  component: PatientChart,
})

// Fixed reference time keeps SSR and client output identical.
const LAB_REF_TIME = Date.UTC(2026, 4, 8)
const EDITABLE_STATUSES: Array<PatientStatus> = [
  'ADMITTED',
  'OUTPATIENT',
  'CRITICAL',
]

function WorkflowCard({
  patientId,
  stage,
  vitalsCount,
  hasDischargeSummary,
}: {
  patientId: string
  stage: Stage
  vitalsCount: number
  hasDischargeSummary: boolean
}) {
  const invalidate = useInvalidatePatientData()
  const [note, setNote] = useState('')
  const move = useMutation({
    mutationFn: (to: Stage) =>
      transitionPatientStage({
        data: { id: patientId, to, note: note.trim() || undefined },
      }),
    onSuccess: async () => {
      setNote('')
      await invalidate()
    },
  })

  const currentIndex = STAGES.indexOf(stage)
  const next = TRANSITIONS[stage]

  return (
    <Card className="md:col-span-2">
      <CardTitle>Care workflow</CardTitle>
      <ol className="m-0 flex list-none flex-wrap gap-2 p-0">
        {STAGES.map((s, i) => (
          <li
            key={s}
            aria-current={s === stage ? 'step' : undefined}
            className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold ${
              s === stage
                ? 'border-[var(--lagoon-deep)] bg-[var(--lagoon-deep)] text-white'
                : i < currentIndex
                  ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-300'
                  : 'border-[var(--line)] text-[var(--sea-ink-soft)]'
            }`}
          >
            {i < currentIndex && <Check size={12} />}
            {STAGE_LABEL[s]}
          </li>
        ))}
      </ol>

      {next.length === 0 ? (
        <CardDescription>
          This episode of care is complete. The workflow is closed.
        </CardDescription>
      ) : (
        <div className="grid gap-3">
          <Input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Optional note for the history (e.g. reason for the change)"
            aria-label="Transition note"
          />
          <div className="flex flex-wrap gap-3">
            {next.map((to) => {
              const check = checkTransition(stage, to, {
                vitalsCount,
                hasDischargeSummary,
              })
              return (
                <div key={to} className="grid gap-1">
                  <Button
                    disabled={!check.ok || move.isPending}
                    onClick={() => move.mutate(to)}
                  >
                    Move to {STAGE_LABEL[to]}
                  </Button>
                  {!check.ok && (
                    <span className="text-xs text-amber-700 dark:text-amber-300">
                      {check.reason}
                    </span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
      {move.isError && (
        <p role="alert" className="m-0 text-sm font-semibold text-red-600">
          {move.error.message}
        </p>
      )}
    </Card>
  )
}

function VitalsCard({
  patientId,
  vitals,
}: {
  patientId: string
  vitals: Array<{
    id: string
    at: string
    heartRate: number
    systolic: number
    diastolic: number
    temperatureC: number
    spo2: number
  }>
}) {
  const invalidate = useInvalidatePatientData()
  const record = useMutation({
    mutationFn: (v: Record<string, string>) =>
      addVitals({
        data: {
          patientId,
          heartRate: Number(v.heartRate),
          systolic: Number(v.systolic),
          diastolic: Number(v.diastolic),
          temperatureC: Number(v.temperatureC),
          spo2: Number(v.spo2),
        },
      }),
    onSuccess: invalidate,
  })

  const form = useAppForm({
    defaultValues: {
      heartRate: '',
      systolic: '',
      diastolic: '',
      temperatureC: '',
      spo2: '',
    },
    validators: { onChange: vitalsFormSchema },
    onSubmit: async ({ value, formApi }) => {
      await record.mutateAsync(value)
      formApi.reset()
    },
  })

  return (
    <Card>
      <CardTitle>Vitals</CardTitle>
      <form
        className="grid grid-cols-2 gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.AppField name="heartRate">
          {(f) => <f.TextField label="Heart rate (bpm)" type="number" />}
        </form.AppField>
        <form.AppField name="spo2">
          {(f) => <f.TextField label="SpO₂ (%)" type="number" />}
        </form.AppField>
        <form.AppField name="systolic">
          {(f) => <f.TextField label="Systolic (mmHg)" type="number" />}
        </form.AppField>
        <form.AppField name="diastolic">
          {(f) => <f.TextField label="Diastolic (mmHg)" type="number" />}
        </form.AppField>
        <form.AppField name="temperatureC">
          {(f) => <f.TextField label="Temperature (°C)" type="number" />}
        </form.AppField>
        <div className="flex items-end">
          <form.AppForm>
            <form.SubscribeButton label="Record vitals" />
          </form.AppForm>
        </div>
      </form>
      {vitals.length === 0 ? (
        <CardDescription>No vitals recorded yet.</CardDescription>
      ) : (
        <ul className="m-0 grid list-none gap-1 p-0 text-sm">
          {vitals.slice(0, 5).map((v) => {
            const alarming =
              v.spo2 < 92 || v.heartRate > 120 || v.temperatureC > 38.5
            return (
              <li key={v.id} className="flex flex-wrap items-center gap-2">
                <span className="text-[var(--sea-ink-soft)]">
                  {new Date(v.at).toLocaleTimeString([], {
                    timeStyle: 'short',
                  })}
                </span>
                HR {v.heartRate} · BP {v.systolic}/{v.diastolic} ·{' '}
                {v.temperatureC}°C · SpO₂ {v.spo2}%
                {alarming && <Badge tone="danger">Check</Badge>}
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function NotesCard({
  patientId,
  notes,
}: {
  patientId: string
  notes: Array<{
    id: string
    kind: NoteKind
    text: string
    at: string
    author: string
  }>
}) {
  const invalidate = useInvalidatePatientData()
  const create = useMutation({
    mutationFn: (v: { kind: NoteKind; text: string }) =>
      addClinicalNote({ data: { patientId, ...v } }),
    onSuccess: invalidate,
  })

  const form = useAppForm({
    defaultValues: { kind: 'PROGRESS', text: '' },
    validators: {
      onChange: noteInputSchema.omit({ patientId: true }).extend({
        kind: noteInputSchema.shape.kind,
      }),
    },
    onSubmit: async ({ value, formApi }) => {
      await create.mutateAsync({
        kind: value.kind as NoteKind,
        text: value.text,
      })
      formApi.reset()
    },
  })

  return (
    <Card>
      <CardTitle>Clinical notes</CardTitle>
      <form
        className="grid gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void form.handleSubmit()
        }}
      >
        <form.AppField name="kind">
          {(f) => (
            <f.Select
              label="Type"
              values={NOTE_KINDS.map((k) => ({ label: k, value: k }))}
            />
          )}
        </form.AppField>
        <form.AppField name="text">
          {(f) => <f.TextArea label="Note" />}
        </form.AppField>
        <form.AppForm>
          <form.SubscribeButton label="Add note" />
        </form.AppForm>
      </form>
      {notes.length === 0 ? (
        <CardDescription>
          No notes yet. A DISCHARGE note is required before discharge.
        </CardDescription>
      ) : (
        <ul className="m-0 grid list-none gap-2 p-0 text-sm">
          {notes.map((n) => (
            <li key={n.id}>
              <div className="flex items-center gap-2">
                <Badge tone={n.kind === 'DISCHARGE' ? 'success' : 'neutral'}>
                  {n.kind}
                </Badge>
                <span className="text-xs text-[var(--sea-ink-soft)]">
                  {new Date(n.at).toLocaleString()} · {n.author}
                </span>
              </div>
              <p className="m-0 mt-1">{n.text}</p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}

function PatientChart() {
  const { patientId } = Route.useParams()
  const invalidate = useInvalidatePatientData()
  const { data: chart } = useSuspenseQuery(chartQuery(patientId))
  const { data: appointments } = useSuspenseQuery(appointmentsQuery())

  const setStatus = useMutation({
    mutationFn: (status: PatientStatus) =>
      updatePatientStatus({ data: { id: patientId, status } }),
    onSuccess: invalidate,
  })

  if (!chart) return null
  const { patient, events, notes, vitals } = chart
  const mine = appointments
    .filter((a) => a.patientId === patientId)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))
  const labs = generatePatientLabs(patientId, LAB_REF_TIME)
  const discharged = patient.stage === 'DISCHARGED'

  return (
    <main className="page-wrap px-4 pb-8 pt-10">
      <Link
        to="/patients"
        className="text-sm font-semibold text-[var(--lagoon-deep)]"
      >
        ← All patients
      </Link>
      <div className="mb-6 mt-3 flex flex-wrap items-center gap-3">
        <h1 className="display-title m-0 text-3xl font-bold text-[var(--sea-ink)]">
          {fullName(patient)}
        </h1>
        <PatientStatusBadge status={patient.status} />
        <StageBadge stage={patient.stage} />
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <WorkflowCard
          patientId={patientId}
          stage={patient.stage}
          vitalsCount={vitals.length}
          hasDischargeSummary={notes.some((n) => n.kind === 'DISCHARGE')}
        />

        <Card>
          <CardTitle>Demographics</CardTitle>
          <dl className="m-0 grid grid-cols-[8rem_1fr] gap-y-2 text-sm">
            <dt className="text-[var(--sea-ink-soft)]">MRN</dt>
            <dd className="m-0">{patient.mrn}</dd>
            <dt className="text-[var(--sea-ink-soft)]">Date of birth</dt>
            <dd className="m-0">{patient.dateOfBirth}</dd>
            <dt className="text-[var(--sea-ink-soft)]">Gender</dt>
            <dd className="m-0">{patient.gender}</dd>
            <dt className="text-[var(--sea-ink-soft)]">Phone</dt>
            <dd className="m-0">{patient.phone}</dd>
            <dt className="text-[var(--sea-ink-soft)]">Ward</dt>
            <dd className="m-0">{patient.ward}</dd>
            <dt className="text-[var(--sea-ink-soft)]">Registered</dt>
            <dd className="m-0">
              {new Date(patient.admittedAt).toLocaleString()}
            </dd>
          </dl>
        </Card>

        <Card>
          <CardTitle>Condition & acuity</CardTitle>
          <p className="m-0 text-sm">{patient.condition}</p>
          <label className="grid gap-1 text-sm font-semibold">
            Acuity
            <Select
              value={patient.status}
              disabled={discharged || setStatus.isPending}
              onChange={(e) =>
                setStatus.mutate(e.target.value as PatientStatus)
              }
            >
              {discharged && <option value="DISCHARGED">DISCHARGED</option>}
              {EDITABLE_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </label>
          {setStatus.isError && (
            <p role="alert" className="m-0 text-sm font-semibold text-red-600">
              {setStatus.error.message}
            </p>
          )}
        </Card>

        <VitalsCard patientId={patientId} vitals={vitals} />
        <NotesCard patientId={patientId} notes={notes} />

        <Card>
          <CardTitle>Recent lab results</CardTitle>
          <ul className="m-0 grid list-none gap-1 p-0 text-sm">
            {labs.map((l) => (
              <li key={l.id} className="flex flex-wrap items-center gap-2">
                <span className="min-w-36">{l.test}</span>
                <span>
                  {l.value} {l.unit}
                </span>
                {l.abnormal && <Badge tone="danger">Abnormal</Badge>}
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardTitle>Appointments ({mine.length})</CardTitle>
          {mine.length === 0 ? (
            <CardDescription>None scheduled.</CardDescription>
          ) : (
            <ul className="m-0 grid list-none gap-2 p-0 text-sm">
              {mine.map((a) => (
                <li key={a.id} className="flex justify-between gap-3">
                  <span>
                    {new Date(a.scheduledAt).toLocaleString()} — {a.reason}
                  </span>
                  <span className="text-[var(--sea-ink-soft)]">{a.status}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card className="md:col-span-2">
          <CardTitle>History</CardTitle>
          <ol className="m-0 grid list-none gap-2 p-0 text-sm">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-[var(--sea-ink-soft)]">
                  {new Date(e.at).toLocaleString()}
                </span>
                {e.from ? (
                  <span>
                    {STAGE_LABEL[e.from]} → <strong>{STAGE_LABEL[e.to]}</strong>
                  </span>
                ) : (
                  <span>
                    Entered at <strong>{STAGE_LABEL[e.to]}</strong>
                  </span>
                )}
                <span className="text-xs text-[var(--sea-ink-soft)]">
                  by {e.by}
                </span>
                {e.note && (
                  <em className="text-[var(--sea-ink-soft)]">“{e.note}”</em>
                )}
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </main>
  )
}
