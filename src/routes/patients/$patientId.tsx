import { Link, createFileRoute, notFound } from '@tanstack/react-router'
import {
  useMutation,
  useQueryClient,
  useSuspenseQuery,
} from '@tanstack/react-query'

import PatientStatusBadge from '#/components/PatientStatusBadge'
import { Card, CardTitle } from '#/components/ui/card'
import { Select } from '#/components/ui/select'
import {
  appointmentsQuery,
  hospitalKeys,
  patientQuery,
} from '#/lib/hospital/queries'
import { PATIENT_STATUSES, fullName } from '#/lib/hospital/schemas'
import type { PatientStatus } from '#/lib/hospital/schemas'
import { updatePatientStatus } from '#/server/hospital.functions'

export const Route = createFileRoute('/patients/$patientId')({
  loader: async ({ context, params }) => {
    const patient = await context.queryClient.ensureQueryData(
      patientQuery(params.patientId),
    )
    if (!patient) throw notFound()
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

function PatientChart() {
  const { patientId } = Route.useParams()
  const queryClient = useQueryClient()
  const { data: patient } = useSuspenseQuery(patientQuery(patientId))
  const { data: appointments } = useSuspenseQuery(appointmentsQuery())

  const setStatus = useMutation({
    mutationFn: (status: PatientStatus) =>
      updatePatientStatus({ data: { id: patientId, status } }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: hospitalKeys.patients }),
        queryClient.invalidateQueries({ queryKey: hospitalKeys.stats }),
      ]),
  })

  if (!patient) return null
  const mine = appointments
    .filter((a) => a.patientId === patientId)
    .sort((a, b) => a.scheduledAt.localeCompare(b.scheduledAt))

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
      </div>

      <div className="grid gap-4 md:grid-cols-2">
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
            <dt className="text-[var(--sea-ink-soft)]">Admitted</dt>
            <dd className="m-0">
              {new Date(patient.admittedAt).toLocaleString()}
            </dd>
          </dl>
        </Card>

        <Card>
          <CardTitle>Care status</CardTitle>
          <p className="m-0 text-sm">{patient.condition}</p>
          <label className="grid gap-1 text-sm font-semibold">
            Update status
            <Select
              value={patient.status}
              disabled={setStatus.isPending}
              onChange={(e) =>
                setStatus.mutate(e.target.value as PatientStatus)
              }
            >
              {PATIENT_STATUSES.map((s) => (
                <option key={s}>{s}</option>
              ))}
            </Select>
          </label>
        </Card>

        <Card className="md:col-span-2">
          <CardTitle>Appointments ({mine.length})</CardTitle>
          {mine.length === 0 ? (
            <p className="m-0 text-sm text-[var(--sea-ink-soft)]">
              None scheduled.
            </p>
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
      </div>
    </main>
  )
}
