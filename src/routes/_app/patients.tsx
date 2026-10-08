import { useState } from 'react'
import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import { listPatients, registerPatient } from '#/server/workflow.functions'
import { Card, ErrorText, Field, btnCls, inputCls } from '#/components/ui'

export const Route = createFileRoute('/_app/patients')({
  loader: () => listPatients(),
  component: Patients,
})

function Patients() {
  const patients = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const register = useServerFn(registerPatient)
  const [error, setError] = useState<string | null>(null)
  const canRegister = user.role === 'frontdesk'

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const f = new FormData(form)
    setError(null)
    try {
      await register({ data: { name: String(f.get('name')), dob: String(f.get('dob')), phone: String(f.get('phone')) } })
      form.reset()
      await router.invalidate({ sync: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed')
    }
  }

  return (
    <main className="page-wrap px-4 py-8">
      <h1 className="mb-6 text-3xl font-bold text-[var(--sea-ink)]">Patients</h1>
      {canRegister && (
        <Card title="1. Register patient">
          <form onSubmit={onSubmit} className="grid gap-4 sm:grid-cols-3">
            <Field label="Full name">
              <input name="name" className={inputCls} required />
            </Field>
            <Field label="Date of birth">
              <input name="dob" type="date" className={inputCls} required />
            </Field>
            <Field label="Phone">
              <input name="phone" className={inputCls} />
            </Field>
            <div className="sm:col-span-3">
              <ErrorText message={error} />
              <button className={btnCls}>Register</button>
            </div>
          </form>
        </Card>
      )}
      <Card>
        <table className="w-full text-left text-sm text-[var(--sea-ink)]">
          <thead>
            <tr className="text-[var(--sea-ink-soft)]">
              <th className="py-2">MRN</th>
              <th>Name</th>
              <th>DOB</th>
              <th>Phone</th>
            </tr>
          </thead>
          <tbody>
            {patients.map((p) => (
              <tr key={p.id} className="border-t border-[var(--line)]">
                <td className="py-2">{p.mrn}</td>
                <td>{p.name}</td>
                <td>{p.dob}</td>
                <td>{p.phone}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </main>
  )
}
