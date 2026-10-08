import { useState } from 'react'
import { Link, createFileRoute, useRouter } from '@tanstack/react-router'
import { useServerFn } from '@tanstack/react-start'
import {
  addInvoiceItem,
  addPrescription,
  cancelVisit,
  checkIn,
  completeConsultation,
  dischargeVisit,
  getVisitDetail,
  markPaid,
  recordVitals,
} from '#/server/workflow.functions'
import { Card, ErrorText, Field, StatusBadge, btnCls, btnGhostCls, inputCls } from '#/components/ui'
import { VISIT_STATUSES, money } from '#/lib/visit'

export const Route = createFileRoute('/_app/visits/$visitId')({
  loader: ({ params }) => getVisitDetail({ data: { visitId: Number(params.visitId) } }),
  component: VisitPage,
})

const STEPS = VISIT_STATUSES.filter((s) => s !== 'cancelled')

function VisitPage() {
  const { visit, prescriptions, items, total_cents } = Route.useLoaderData()
  const { user } = Route.useRouteContext()
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)

  const fns = {
    checkIn: useServerFn(checkIn),
    cancel: useServerFn(cancelVisit),
    vitals: useServerFn(recordVitals),
    prescribe: useServerFn(addPrescription),
    complete: useServerFn(completeConsultation),
    charge: useServerFn(addInvoiceItem),
    paid: useServerFn(markPaid),
    discharge: useServerFn(dischargeVisit),
  }

  async function run(action: () => Promise<unknown>, form?: HTMLFormElement) {
    setError(null)
    try {
      await action()
      form?.reset()
      await router.invalidate({ sync: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed')
    }
  }

  const visitId = visit.id
  const is = (role: string) => user.role === role || user.role === 'admin'
  const submit =
    (fn: (f: FormData) => Promise<unknown>) => (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault()
      const form = e.currentTarget
      void run(() => fn(new FormData(form)), form)
    }
  const s = visit.status

  return (
    <main className="page-wrap px-4 py-8">
      <Link to="/" className="text-sm font-semibold">
        ← Worklist
      </Link>
      <h1 className="mb-2 mt-2 text-3xl font-bold text-[var(--sea-ink)]">
        {visit.patient_name} <span className="text-lg text-[var(--sea-ink-soft)]">{visit.mrn}</span>
      </h1>
      <p className="mb-4 text-[var(--sea-ink-soft)]">
        {visit.scheduled_at.replace('T', ' ')} · {visit.doctor_name} · {visit.reason} · <StatusBadge status={s} />
      </p>

      <ol className="mb-6 flex flex-wrap gap-2 text-xs font-semibold text-[var(--sea-ink-soft)]">
        {STEPS.map((step) => (
          <li
            key={step}
            className={step === s ? 'rounded-full bg-[var(--lagoon-deep)] px-3 py-1 text-[var(--foam)]' : 'px-3 py-1'}
          >
            {step.replace('_', ' ')}
          </li>
        ))}
      </ol>
      <ErrorText message={error} />

      {s === 'scheduled' && is('frontdesk') && (
        <Card title="3. Check in">
          <div className="flex gap-3">
            <button className={btnCls} onClick={() => run(() => fns.checkIn({ data: { visitId } }))}>
              Check patient in
            </button>
            <button className={btnGhostCls} onClick={() => run(() => fns.cancel({ data: { visitId } }))}>
              Cancel appointment
            </button>
          </div>
        </Card>
      )}

      {s === 'checked_in' && is('nurse') && (
        <Card title="4. Triage — record vitals">
          <form className="space-y-3" onSubmit={submit((f) => fns.vitals({ data: { visitId, vitals: String(f.get('vitals')) } }))}>
            <Field label="Vitals (BP, HR, temp, SpO₂, weight…)">
              <input name="vitals" className={inputCls} required />
            </Field>
            <button className={btnCls}>Save vitals</button>
          </form>
        </Card>
      )}

      {visit.vitals && (
        <Card title="Vitals">
          <p className="text-[var(--sea-ink)]">{visit.vitals}</p>
        </Card>
      )}

      {s === 'triaged' && is('doctor') && (
        <>
          <Card title="5a. Prescribe">
            <form
              className="grid gap-3 sm:grid-cols-3"
              onSubmit={submit((f) =>
                fns.prescribe({
                  data: {
                    visitId,
                    drug: String(f.get('drug')),
                    dose: String(f.get('dose')),
                    instructions: String(f.get('instructions')),
                  },
                }),
              )}
            >
              <Field label="Drug">
                <input name="drug" className={inputCls} required />
              </Field>
              <Field label="Dose">
                <input name="dose" className={inputCls} required />
              </Field>
              <Field label="Instructions">
                <input name="instructions" className={inputCls} />
              </Field>
              <div className="sm:col-span-3">
                <button className={btnGhostCls}>Add prescription</button>
              </div>
            </form>
          </Card>
          <Card title="5b. Conclude consultation">
            <form
              className="space-y-3"
              onSubmit={submit((f) =>
                fns.complete({
                  data: { visitId, diagnosis: String(f.get('diagnosis')), notes: String(f.get('notes')) },
                }),
              )}
            >
              <Field label="Diagnosis">
                <input name="diagnosis" className={inputCls} required />
              </Field>
              <Field label="Clinical notes">
                <textarea name="notes" rows={4} className={inputCls} />
              </Field>
              <button className={btnCls}>Complete consultation</button>
            </form>
          </Card>
        </>
      )}

      {(visit.diagnosis || visit.notes) && (
        <Card title="Consultation">
          <p className="font-semibold text-[var(--sea-ink)]">{visit.diagnosis}</p>
          <p className="whitespace-pre-wrap text-[var(--sea-ink-soft)]">{visit.notes}</p>
        </Card>
      )}

      {prescriptions.length > 0 && (
        <Card title="Prescriptions">
          <ul className="list-disc pl-5 text-[var(--sea-ink)]">
            {prescriptions.map((p) => (
              <li key={p.id}>
                {p.drug} — {p.dose} {p.instructions && `(${p.instructions})`}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {items.length > 0 && (
        <Card title="6. Invoice">
          <table className="mb-3 w-full text-sm text-[var(--sea-ink)]">
            <tbody>
              {items.map((i) => (
                <tr key={i.id} className="border-t border-[var(--line)]">
                  <td className="py-2">{i.description}</td>
                  <td className="text-right">{money(i.amount_cents)}</td>
                </tr>
              ))}
              <tr className="border-t border-[var(--line)] font-bold">
                <td className="py-2">Total</td>
                <td className="text-right">{money(total_cents)}</td>
              </tr>
            </tbody>
          </table>
          {s === 'consulted' && is('billing') && (
            <div className="space-y-4">
              <form
                className="grid gap-3 sm:grid-cols-3"
                onSubmit={submit((f) =>
                  fns.charge({
                    data: { visitId, description: String(f.get('description')), amount: Number(f.get('amount')) },
                  }),
                )}
              >
                <Field label="Charge">
                  <input name="description" className={inputCls} required />
                </Field>
                <Field label="Amount ($)">
                  <input name="amount" type="number" step="0.01" min="0.01" className={inputCls} required />
                </Field>
                <div className="flex items-end">
                  <button className={btnGhostCls}>Add charge</button>
                </div>
              </form>
              <button className={btnCls} onClick={() => run(() => fns.paid({ data: { visitId } }))}>
                Record payment received
              </button>
            </div>
          )}
        </Card>
      )}

      {s === 'paid' && is('frontdesk') && (
        <Card title="7. Discharge">
          <form className="space-y-3" onSubmit={submit((f) => fns.discharge({ data: { visitId, summary: String(f.get('summary')) } }))}>
            <Field label="Discharge summary / follow-up">
              <textarea name="summary" rows={3} className={inputCls} />
            </Field>
            <button className={btnCls}>Discharge patient</button>
          </form>
        </Card>
      )}

      {visit.discharge_summary !== null && s === 'discharged' && (
        <Card title="Discharged">
          <p className="text-[var(--sea-ink-soft)]">{visit.discharge_summary || 'No summary recorded.'}</p>
        </Card>
      )}
    </main>
  )
}
