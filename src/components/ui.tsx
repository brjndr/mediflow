import type { ReactNode } from 'react'
import { STATUS_LABEL, type VisitStatus } from '#/lib/visit'

export const inputCls =
  'w-full rounded-lg border border-[var(--line)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--sea-ink)]'
export const btnCls =
  'rounded-full bg-[var(--lagoon-deep)] px-4 py-2 text-sm font-semibold text-[var(--foam)] disabled:opacity-50'
export const btnGhostCls =
  'rounded-full border border-[var(--line)] px-4 py-2 text-sm font-semibold text-[var(--sea-ink)] disabled:opacity-50'

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="island-shell mb-6 rounded-2xl p-5">
      {title && <h2 className="mb-3 text-lg font-bold text-[var(--sea-ink)]">{title}</h2>}
      {children}
    </section>
  )
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block text-sm font-semibold text-[var(--sea-ink-soft)]">
      <span className="mb-1 block">{label}</span>
      {children}
    </label>
  )
}

export function StatusBadge({ status }: { status: VisitStatus }) {
  return (
    <span className="rounded-full border border-[var(--chip-line)] bg-[var(--chip-bg)] px-2.5 py-0.5 text-xs font-semibold text-[var(--sea-ink)]">
      {STATUS_LABEL[status]}
    </span>
  )
}

export function ErrorText({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm font-semibold text-red-600">
      {message}
    </p>
  ) : null
}
