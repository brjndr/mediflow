# MediFlow — Hospital Management (TanStack)

Patients registry, appointment board, lab records and an AI operations assistant,
built to demonstrate **TanStack Start, Router, Intent, CLI, Query, Table, Form,
Store, DB, AI, Hotkeys, Pacer and Virtual**. Sample data only.

```bash
npm install
npm run db:generate   # generates the Prisma client (needs a dummy DATABASE_URL in .env.local)
npm run dev           # http://localhost:3000 — runs with in-memory data, no DB
```

Press **?** in the app for keyboard shortcuts. See **AGENTS.md** for the exact
scaffold command, architecture, environment variables, gotchas and next steps,
and `/about` in the app for a map of which TanStack library powers which screen.

| Route                             | Highlights                                           |
| --------------------------------- | ---------------------------------------------------- |
| `/`                               | Dashboard — Query + loaders                          |
| `/patients`                       | Table v9, URL search params, Pacer debounce, Hotkeys |
| `/patients/new`                   | TanStack Form + zod, `Ctrl/⌘+Enter`                  |
| `/patients/$patientId`            | Chart view, status mutation                          |
| `/appointments`                   | TanStack DB live join + optimistic updates           |
| `/records`                        | TanStack Virtual, 25,000 rows                        |
| header assistant, `/demo/ai-chat` | TanStack AI with hospital tools                      |

Scripts: `dev`, `build`, `lint` (ESLint), `check` (Prettier), `db:*` (Prisma).
