import { Link, createFileRoute } from '@tanstack/react-router'
import { useSuspenseQuery } from '@tanstack/react-query'

import { Badge } from '#/components/ui/badge'
import { Card, CardDescription, CardTitle } from '#/components/ui/card'
import { statsQuery } from '#/lib/hospital/queries'
import { PATIENT_STATUSES, patientStatusTone } from '#/lib/hospital/schemas'
import { STAGES, STAGE_LABEL } from '#/lib/hospital/workflow'

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(statsQuery()),
  component: Dashboard,
})

function Dashboard() {
  // Refetch every 30s so the census stays fresh without a manual reload.
  const { data: stats } = useSuspenseQuery({
    ...statsQuery(),
    refetchInterval: 30_000,
  })
  const maxWard = Math.max(...stats.byWard.map((w) => w.count), 1)

  return (
    <main className="page-wrap px-4 pb-8 pt-10">
      <section className="island-shell rise-in mb-6 rounded-[2rem] px-6 py-8 sm:px-10">
        <p className="island-kicker mb-2">MediFlow</p>
        <h1 className="display-title m-0 mb-3 text-4xl font-bold tracking-tight text-[var(--sea-ink)] sm:text-5xl">
          Hospital operations, at a glance.
        </h1>
        <p className="m-0 max-w-2xl text-[var(--sea-ink-soft)]">
          Census, appointments and lab records — built end-to-end with the
          TanStack ecosystem. Press{' '}
          <kbd className="rounded border border-[var(--line)] px-1">?</kbd> for
          keyboard shortcuts.
        </p>
      </section>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardDescription>Total patients</CardDescription>
          <p className="m-0 text-4xl font-bold">{stats.totalPatients}</p>
        </Card>
        {PATIENT_STATUSES.slice(0, 3).map((s) => (
          <Card key={s}>
            <CardDescription>
              <Badge tone={patientStatusTone[s]}>{s}</Badge>
            </CardDescription>
            <p className="m-0 text-4xl font-bold">{stats.byStatus[s]}</p>
          </Card>
        ))}
      </div>

      <Card className="mt-4">
        <CardTitle>Care pipeline</CardTitle>
        <ol className="m-0 grid list-none gap-3 p-0 sm:grid-cols-3 lg:grid-cols-6">
          {STAGES.map((s) => (
            <li key={s} className="rounded-xl border border-[var(--line)] p-3">
              <p className="m-0 text-2xl font-bold">{stats.byStage[s]}</p>
              <p className="m-0 text-xs text-[var(--sea-ink-soft)]">
                {STAGE_LABEL[s]}
              </p>
            </li>
          ))}
        </ol>
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardTitle>Patients by ward</CardTitle>
          <ul className="m-0 grid list-none gap-2 p-0">
            {stats.byWard.map((w) => (
              <li
                key={w.ward}
                className="grid grid-cols-[7rem_1fr_2rem] items-center gap-3 text-sm"
              >
                <span>{w.ward}</span>
                <div className="h-2.5 overflow-hidden rounded-full bg-[var(--line)]">
                  <div
                    className="h-full rounded-full bg-[var(--lagoon-deep)]"
                    style={{ width: `${(w.count / maxWard) * 100}%` }}
                  />
                </div>
                <span className="text-right font-semibold">{w.count}</span>
              </li>
            ))}
          </ul>
        </Card>

        <Card>
          <CardTitle>Appointments</CardTitle>
          <p className="m-0 text-4xl font-bold">{stats.appointmentsToday}</p>
          <CardDescription>scheduled today</CardDescription>
          <div className="flex flex-wrap gap-2 text-xs">
            <Badge tone="info">
              {stats.appointmentsByStatus.SCHEDULED} scheduled
            </Badge>
            <Badge tone="warning">
              {stats.appointmentsByStatus.CHECKED_IN} checked in
            </Badge>
            <Badge tone="success">
              {stats.appointmentsByStatus.COMPLETED} completed
            </Badge>
          </div>
          <Link
            to="/appointments"
            className="text-sm font-semibold text-[var(--lagoon-deep)]"
          >
            Open the appointment board →
          </Link>
        </Card>
      </div>
    </main>
  )
}
