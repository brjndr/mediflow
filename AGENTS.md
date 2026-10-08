# MediFlow — Hospital Management System

Durable project context for humans and AI agents. Keep this file up to date.

## Scaffolding commands (exact)

```bash
# Run in a scratch directory, then merged into this repo (repo already had a README + git history)
npx @tanstack/cli@latest create my-tanstack-app --agent --package-manager pnpm --tailwind --add-ons tanstack-query

# Follow-up TanStack Intent commands (run from repo root)
npx @tanstack/intent@latest install   # needs an interactive terminal to confirm permissions (see gotchas)
npx @tanstack/intent@latest list      # lists skills shipped by installed packages
pnpm exec intent load <package>#<skill>   # load a specific skill before using that library
```

The generated project was copied to the repo root; `package.json` name and `.cta.json` projectName were renamed from `my-tanstack-app` to `mediflow`. Nothing else was altered.

## Stack

- React 19 + TanStack Start (SSR, Vite 8) + TanStack Router (file-based, `src/routes`, generated `src/routeTree.gen.ts`)
- TanStack Query add-on (`src/integrations/tanstack-query/`, SSR-Query integration wired in `src/router.tsx`)
- Tailwind CSS v4 (`@tailwindcss/vite`, `src/styles.css`), TypeScript 6
- Toolchain: default CLI toolchain (no ESLint/Prettier/Vitest added), pnpm, `#/*` import alias -> `src/*`
- Blank-starter demo routes (`about`, `demo/`), Header/Footer and the Query devtools stub were removed when the workflow was added. The Query provider/SSR integration is still wired in `src/router.tsx`, but the workflow reads via route loaders + `router.invalidate()` (the pattern the shipped server-functions skill recommends). Use `queryOptions` + `useQuery` when you need client-side caching/polling.
- Database: SQLite via Node's built-in `node:sqlite` (Node >= 22.13; no ORM, no native deps). Path from `DATABASE_PATH` (default `./mediflow.db`, git-ignored). Schema + demo seed live in `src/server/db.ts`, created on first use.
- Auth: opaque random session token in an HttpOnly, SameSite=Lax cookie (Secure in production); only its SHA-256 is stored in `sessions`; scrypt password hashes; session rotation on login; dummy-hash verify for unknown users.

## Scripts

`pnpm dev` (port 3000) · `pnpm build` · `pnpm preview` · `pnpm generate-routes`

## Patient workflow (implemented, demo-grade)

Visit status machine: `scheduled -> checked_in -> triaged -> consulted -> paid -> discharged` (or `cancelled` before triage).

| Step | Who | Server function |
|------|-----|-----------------|
| 1 Register patient | frontdesk | `registerPatient` |
| 2 Book appointment | frontdesk | `bookAppointment` |
| 3 Check in / cancel | frontdesk | `checkIn`, `cancelVisit` |
| 4 Triage vitals | nurse | `recordVitals` |
| 5 Prescribe + conclude consult (auto-adds consultation fee) | doctor (own patients) | `addPrescription`, `completeConsultation` |
| 6 Add charges, record payment | billing | `addInvoiceItem`, `markPaid` |
| 7 Discharge (requires paid) | frontdesk | `dischargeVisit` |

`admin` passes every role check. Doctors only see their own visits. Every transition checks the current status server-side and writes to `audit_log`. Code: `src/server/` (`db.ts`, `auth.ts`, `middleware.ts`, `workflow.functions.ts`), shared constants in `src/lib/visit.ts`, UI in `src/routes/` (`login`, `_app` layout guard, `_app/index` worklist, `_app/patients`, `_app/visits.$visitId`).

Demo accounts (seeded, FAKE data only; password `mediflow-demo`): `admin`, `frontdesk`, `nurse`, `doctor`, `billing`. **Change/remove before any real deployment.**

## Environment variables

- `DATABASE_PATH` (optional): SQLite file path, default `./mediflow.db`.
- `NODE_ENV=production` makes the session cookie `Secure`.

No other variables are required yet. Client-exposed vars must be prefixed `VITE_`; server-only vars use `process.env` inside server functions. `.env` is git-ignored. When a database/auth is added, document vars here (e.g. `DATABASE_URL`, `SESSION_SECRET`).

## Deployment notes

No deploy target is chosen yet. TanStack Start supports Node, Netlify, Vercel, Cloudflare, Bun, etc. — load the skill `@tanstack/start-client-core#start-core/deployment` before choosing and adding the adapter/plugin.

## Architectural decisions

- Keep generated structure; add domain features as routes under `src/routes/` (e.g. `patients`, `appointments`, `staff`, `billing`) and data access through `createServerFn` + TanStack Query (`queryOptions`) with loaders prefetching via the router's query client.
- Before library-specific changes, run `pnpm exec intent list` and load the relevant skill (router-core, start-core, server-functions, middleware, auth-server-primitives, etc.).

## Known gotchas

- `intent install` run non-interactively prints `intent.skills is not configured` — run it in an interactive terminal to confirm permissions. `intent list` still works.
- Keep server-only code out of the client graph: `node:*` and `@tanstack/react-start/server` imports stay in `src/server/*`; `createMiddleware` lives in `middleware.ts` (its `.server()` body is stripped for the client); never re-export server modules from files client code imports. A violation fails `pnpm build` with an "import protection" error.
- SQLite file storage needs a persistent disk; it won't survive serverless/ephemeral deploys. Swap `getDb()` for Postgres before deploying that way.
- In `pnpm dev`, forms submitted before hydration fall back to a native submit (the login form is `method="post"` so credentials never land in the URL).
- `.validator()` is the current API; `.inputValidator()` is deprecated in the installed version.
- Don't `pkill -f vite` from an agent shell (it matches its own command line); use `fuser -k 3000/tcp`.
- `src/routeTree.gen.ts` is generated and git-ignored; run `pnpm dev`/`pnpm generate-routes` before typechecking in a fresh clone.
- `pnpm-workspace.yaml` holds pnpm `onlyBuiltDependencies` settings; keep it.
- Hospital data is PHI: no real patient data in dev; plan auth, audit logging and encryption before any persistence.

## Next steps

1. Run `npx @tanstack/intent@latest install` interactively and commit its result (agent config/`intent.skills`).
2. Add automated tests (Vitest for the status machine, Playwright for the 7-step flow) and CI; the flow was so far verified only with an ad-hoc Playwright script.
3. Production hardening: login rate limiting, CSRF/origin check on POST server functions, password change/user admin UI, session cleanup, audit viewer, encryption at rest.
4. Extend the domain: wards/beds and admissions, lab orders, insurance, appointment slot conflicts, patient search, edit/merge patients.
5. Move to Postgres (+ ORM) if deploying to serverless; pick a deployment target.
