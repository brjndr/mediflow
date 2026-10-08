import { createFileRoute } from '@tanstack/react-router'

export const Route = createFileRoute('/about')({
  component: About,
})

const STACK = [
  [
    'TanStack Start',
    'Full-stack framework: SSR, server functions (src/server/hospital.functions.ts), the AI chat server route.',
  ],
  [
    'TanStack Router',
    'Type-safe file routes, loaders, validated search params (/patients?q=&status=), notFound handling.',
  ],
  [
    'TanStack Query',
    'All server state: patients, stats, doctors. Loaders prefetch with ensureQueryData; mutations invalidate.',
  ],
  [
    'TanStack Table (v9)',
    '/patients — sorting, global + column filtering and pagination with feature-registered row models.',
  ],
  [
    'TanStack Form',
    '/patients/new and the booking form — shared zod schema validates on client and server.',
  ],
  [
    'TanStack Store',
    'src/lib/hospital/ui-store.ts — density and shortcut-dialog state; also the AI assistant panel toggle.',
  ],
  [
    'TanStack DB',
    '/appointments — client-side collections, a live three-way join and optimistic check-in / complete / cancel.',
  ],
  [
    'TanStack AI',
    'Header assistant and /demo/ai-chat — hospital tools (stats, patient search) plus a client-rendered patient card.',
  ],
  [
    'TanStack Hotkeys',
    'Global G-sequences, ?, / and N, Mod+Enter to submit forms. Press ? to see them all.',
  ],
  [
    'TanStack Pacer',
    'Debounced search on /patients (writes to the URL) and /records.',
  ],
  [
    'TanStack Virtual',
    '/records — 25,000 lab results rendered through a windowed list.',
  ],
  [
    'TanStack CLI & Intent',
    'Project scaffolded with the TanStack CLI; AGENTS.md carries Intent skill mappings for coding agents.',
  ],
] as const

function About() {
  return (
    <main className="page-wrap px-4 py-12">
      <section className="island-shell rounded-2xl p-6 sm:p-8">
        <p className="island-kicker mb-2">How MediFlow is built</p>
        <h1 className="display-title mb-6 text-4xl font-bold text-[var(--sea-ink)]">
          The TanStack stack
        </h1>
        <dl className="m-0 grid gap-4 sm:grid-cols-2">
          {STACK.map(([name, text]) => (
            <div key={name}>
              <dt className="font-semibold text-[var(--sea-ink)]">{name}</dt>
              <dd className="m-0 text-sm text-[var(--sea-ink-soft)]">{text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </main>
  )
}
