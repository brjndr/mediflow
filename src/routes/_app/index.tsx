import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { bookAppointment, listDoctors, listPatients, listVisits } from '#/server/workflow.functions'
import { Card, ErrorText, Field, StatusBadge, btnCls, inputCls } from '#/components/ui'
import { NEXT_ACTOR } from '#/lib/visit'

export const Route = createFileRoute('/_app/')({
  loader: async ({ context }) => {
    const visits = await listVisits()
    // Only the front desk books; skip the extra reads for other roles.
    if (context.user.role !== 'frontdesk') return { visits, patients: [], doctors: [] }
    const [patients, doctors] = await Promise.all([listPatients(), listDoctors()])
    return { visits, patients, doctors }
  },
  component: Worklist,
})

function Worklist() {
  const { visits, patients, doctors } = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const book = useServerFn(bookAppointment)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    setError(null)
    try {
      await book({
        data: {
          patientId: Number(f.get('patientId')),
          doctorId: Number(f.get('doctorId')),
          scheduledAt: String(f.get('scheduledAt')),
          reason: String(f.get('reason')),
        },
      })
      form.reset()
      await router.invalidate({ sync: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    }
  }

  const mine = visits.filter((v) => NEXT_ACTOR[v.status] === user.role)
  const rest = visits.filter((v) => NEXT_ACTOR[v.status] !== user.role)

  const table = (rows: typeof visits) => (
    <table className="w-full text-left text-sm text-[var(--sea-ink)]">
      <thead>
        <tr className="text-[var(--sea-ink-soft)]">
          <th className="py-2">When</th>
          <th>Patient</th>
          <th>Doctor</th>
          <th>Reason</th>
          <th>Status</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {rows.map((v) => (
          <tr key={v.id} className="border-t border-[var(--line)]">
            <td className="py-2">{v.scheduled_at.replace('T', ' ')}</td>
            <td>
              {v.patient_name} <span className="text-[var(--sea-ink-soft)]">({v.mrn})</span>
            </td>
            <td>{v.doctor_name}</td>
            <td>{v.reason}</td>
            <td>
              <StatusBadge status={v.status} />
            </td>
            <td>
              <Link to="/visits/$visitId" params={{ visitId: String(v.id) }} className="font-semibold">
                Open
              </Link>
            </td>
          </tr>
        ))}
        {rows.length === 0 && (
          <tr>
            <td colSpan={6} className="py-3 text-[var(--sea-ink-soft)]">
              Nothing here.
            </td>
          </tr>
        )}
      </tbody>
    </table>
  )

  return (
    <main className="page-wrap px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold text-[var(--sea-ink)]">Worklist</h1>
      {user.role === 'frontdesk' && (
        <Card title="2. Book appointment">
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-2">
            <Field label="Patient">
              <select name="patientId" className={inputCls} required>
                {patients.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.mrn})
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Doctor">
              <select name="doctorId" className={inputCls} required>
                {doctors.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Date & time">
              <input name="scheduledAt" type="datetime-local" className={inputCls} required />
            </Field>
            <Field label="Reason for visit">
              <input name="reason" className={inputCls} required />
            </Field>
            <div className="sm:col-span-2">
              <ErrorText message={error} />
              <button className={btnCls}>Book</button>
            </div>
          </form>
        </Card>
      )}
      {user.role !== 'admin' && <Card title="Waiting for you">{table(mine)}</Card>}
      <Card title={user.role === 'admin' ? 'All visits' : 'Other visits'}>{table(user.role === 'admin' ? visits : rest)}</Card>
    </main>
  )
}
