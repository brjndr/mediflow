# Hospital Management System (HMS)

## Overview

Permission-based, **multi-tenant** web app serving **multiple hospitals** from one deployment. Covers patient records, appointments, clinical workflows, and billing. It is an **end-to-end HMS**: it covers the whole patient journey from arrival to exit (OPD, inpatient, emergency, diagnostics, pharmacy, billing, insurance and records), like a conventional hospital management system. See Product Scope. Must handle **very high traffic** (many hospitals, many concurrent users). This is a **pnpm monorepo** holding the React SPA (`apps/web`), the Fastify API (`apps/api`) and a shared contract package (`packages/contract`). See Repository Layout. Until the backend issues are done, the web app runs against an MSW mock API.

**Staff-only application.** Only hospital staff (and platform admins) have accounts and can sign in. Patients are records managed by staff (registered, scheduled, treated, billed). There is no patient login, patient portal, or patient self-service anywhere in this product. Outbound patient reminders are a planned future feature: v1 must be built so it (or any other feature) can be added as a plug-in module without changing core code. See "Adding a new feature later".

Five non-negotiables shape every decision:

1. **Tenant isolation:** one hospital must never see another hospital's data or config.
2. **Scale:** performance and resilience are features, not afterthoughts.
3. **Extensibility and configurable access:** new features plug in without touching core code, and any feature or action can be enabled/disabled per hospital and per role without a redeploy.
4. **Production-grade but cheap:** proven open-source technology, a small fixed cost to start, and cost that grows with usage rather than ahead of it. See Technology Decisions and Cost Strategy.
5. **Fast and effective:** the product must feel instant and stay correct under load. Choose the best proven tool for each job rather than the smallest one. Weight is accepted when it buys real capability, and it is controlled with code splitting, budgets and measurement. See Performance Strategy.

## Product Scope: End-to-End Patient Journey

The product must support a hospital's complete workflow, not just a few screens. Modules are delivered in four releases, each shippable and each built as feature modules that a hospital can enable or disable (a small clinic runs OPD only, a large hospital enables everything). Full issue list: `docs/ROADMAP.md`.

### Journeys

- **OPD:** register or find patient -> appointment or walk-in token -> triage (vitals, allergies) -> consultation -> orders (lab, imaging, medication, procedures) -> sample collection and results -> prescription -> pharmacy dispense -> billing and payment -> follow-up or referral.
- **IPD:** admission advice -> bed allocation (ADT) -> nursing care (vitals, medication administration, notes) -> doctor rounds and orders -> diagnostics and pharmacy -> running bill and deposits -> discharge clearance -> discharge summary -> final bill or insurance settlement -> bed cleaning.
- **Emergency:** quick or unidentified registration -> triage -> rapid care -> disposition (discharge, admit to IPD, refer, expired). Patients may be merged into a real identity later.
- **Surgery:** OT booking -> pre-op checklist -> operation and anaesthesia notes -> consumables and charges -> post-op care.
- **Insured patients:** policy capture -> pre-authorization -> split billing -> claim submission -> settlement.

### Module map and releases

| Release                               | Modules                                                                                                                                                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R1 Pilot (OPD hospital or clinic)** | Auth and roles, patients, doctors and departments, master data and catalogs, appointments, queue and triage, OPD clinical and orders, laboratory, radiology, pharmacy and inventory, billing, reports, platform admin, role management |
| **R2 Inpatient**                      | Bed management and admissions (ADT), nursing and ward care, discharge and IPD billing                                                                                                                                                  |
| **R3 Specialty and payers**           | Emergency, operation theatre, insurance, TPA and claims                                                                                                                                                                                |
| **R4 Records and operations**         | Medical records and documents, consents and certificates, rosters, blood bank, ambulance, housekeeping                                                                                                                                 |

### Architecture rules that make the modules fit together

- **Encounter is the spine.** Every clinical, ordering and billing record attaches to an `Encounter` (type `opd`, `ipd`, `er` or `daycare`), which belongs to one patient. Modules never invent their own visit concept.
- **Unified orders (CPOE).** Lab, imaging, procedure, medication and diet requests are all `Order` records with a type, status and `order.placed` event. Lab, radiology, pharmacy and nursing modules consume orders by event. Ordering never calls those modules directly.
- **Charge ledger.** Services performed, tests, imaging, dispenses, bed days and procedures post **charges** to the encounter's charge ledger (priced from the active price list at that time). Invoices are assembled from charges. No module writes invoices directly.
- **Master data first.** Services and tariffs, drugs, lab tests, ICD codes, wards and beds are catalogs owned by the master data module and referenced by ID everywhere else. Prices are effective-dated so old bills never change.
- **Append-only where it matters:** stock ledger, medication administration record, audit log, results and signed documents. Corrections are new entries or addenda with the reason and the author.
- **State machines** for orders, samples, admissions, bed status, claims and discharge, enforced on the backend. The UI only offers valid transitions.
- **Concurrency-safe resources:** double-booking, bed occupancy, theatre and surgeon slots, and stock decrements are protected by database constraints or row locks, never by client checks.
- **Every module is a feature module** with its own flag, permissions, migrations, events and settings, and registers via the manifest and Fastify plugin. A module that needs another one's data uses events or its `index.ts` contract.
- Large code sets (ICD-10, drug and test catalogs) are searched on the server and never bundled into the web app.

### Out of scope for now (see Open Decisions)

Patient portal or app, telemedicine, a DICOM viewer or PACS, full accounting or payroll, and external integrations (HL7/FHIR, lab analyzers, ABDM/ABHA, e-claim portals). Design data models so these can be added later through adapters.

## Stack

- React 18 + TypeScript (strict) + Vite. Ships as a **static SPA** (no SSR needed for an authenticated app), which keeps hosting nearly free at any traffic level
- Tailwind CSS + shadcn/ui (Radix primitives, imported one at a time): free, small, accessible, themeable per tenant through CSS variables
- TanStack React Query: all server state, **including the session, tenant config and `AccessPolicy`** (`GET /session`)
- **Redux Toolkit** for client and workflow state (multi-step admission and discharge flows, order drafts held in memory, UI preferences, cross-screen selections). Server data never goes in Redux. Session, tenant config and `AccessPolicy` stay in React Query behind small contexts, and every Redux slice resets on tenant switch and logout. Never persist PHI to browser storage
- React Router v6 (declarative routes generated from the registry, route-level lazy loading, no data-router features)
- React Hook Form + **Zod** (`@hookform/resolvers`)
- Native **`fetch`** behind a thin wrapper in `shared/api` (retry, abort, tenant consistency header, error mapping), plus a typed client generated from the backend's OpenAPI spec (`openapi-typescript` + `openapi-fetch`) so types never drift. Axios is acceptable if a feature needs its interceptor model, but the generated typed client is the default
- **i18next** with `react-i18next`: localization, with namespaces per feature loaded on demand and language from tenant config
- **Dates and formatting:** `Intl` APIs for display, plus `date-fns` and `date-fns-tz` for arithmetic and tenant timezones. Icons from `lucide-react`
- **Tables and lists:** TanStack Table for data grids (sorting, column visibility, selection, pinned columns) and TanStack Virtual for long lists and timelines
- **Charts:** Recharts for dashboards and reports, with ECharts (lazy-loaded) allowed for dense or large analytics views
- **Scheduling views:** FullCalendar (free core plugins) or react-big-calendar for appointment, roster and theatre calendars. Paid premium plugins (such as resource timeline) need an explicit decision because of licence cost
- **Rich text:** TipTap for clinical notes, templates and discharge summaries (sanitized output, no raw HTML injection)
- **Motion:** `motion` (Framer Motion) for meaningful transitions, kept off critical paths
- **Documents:** official PDFs and Excel exports (invoices, discharge summaries, reports) are generated on the server for consistent output and audit. Client-side libraries (react-pdf, SheetJS) are allowed for previews and import mapping
- Testing: Vitest + React Testing Library + MSW, Playwright for end-to-end
- Observability: web-vitals and Sentry (errors only, no replay or tracing) loaded lazily after first paint, with PHI scrubbing

## Technology Decisions and Cost Strategy

### Principles

- Prefer boring, proven, open-source tech. One well-chosen tool per layer.
- Start small and cheap, but design so scaling needs **configuration, not rewrites** (stateless services, `tenant_id` everywhere, cursor pagination, idempotency).
- Avoid per-seat or per-event SaaS until revenue justifies it. Avoid lock-in on anything whose bill grows with traffic.
- Do not build later-phase infrastructure until metrics demand it.

### Target architecture

| Layer                     | Choice                                                                                                                                                                                                                                        | Why                                                                                                                                                  |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Frontend hosting          | Static SPA on a CDN (Cloudflare Pages to start; CloudFront if fully on AWS)                                                                                                                                                                   | Static delivery costs almost nothing at huge traffic; one shared domain and one certificate for all hospitals                                        |
| API                       | **Modular monolith**: Fastify (TypeScript) with TypeBox schemas and `@fastify/swagger`, REST + OpenAPI, stateless containers                                                                                                                  | One deployable is cheapest to run and operate; shared TS types; extract a service later only when a module needs independent scaling                 |
| Database                  | PostgreSQL, **shared schema + `tenant_id` + row-level security**, managed service in an India region                                                                                                                                          | Lowest cost per hospital; scales with read replicas and partitioning. "Pooled by default, dedicated DB on demand" for very large or strict hospitals |
| Cache / queue             | Phase 1: Postgres-backed job queue (pg-boss) with in-process cache and rate limits, behind interfaces. Phase 2+: Redis for shared cache, rate limits and queues (BullMQ)                                                                      | Fewest moving parts at the start. Swapping is a config change                                                                                        |
| Search                    | Postgres full-text + `pg_trgm` first; OpenSearch only if proven necessary                                                                                                                                                                     | Avoids an expensive cluster early                                                                                                                    |
| Files (reports, lab PDFs) | S3-compatible object storage, encrypted, signed URLs, lifecycle rules to cheaper tiers                                                                                                                                                        | Cheap and durable                                                                                                                                    |
| Realtime                  | Server-Sent Events first; WebSocket only if truly needed                                                                                                                                                                                      | Simpler and cheaper to scale                                                                                                                         |
| Auth                      | Backend-issued sessions stored in Postgres (httpOnly cookies via `@fastify/cookie`, refresh rotation), `@node-rs/argon2` for passwords, `otplib` for MFA; OIDC/SAML hospital SSO via self-hosted Keycloak when the first hospital requires it | No per-user SaaS fees; never hand-roll crypto                                                                                                        |
| Notifications             | v1: staff-only email (invites, password resets, report-ready alerts) via a provider-abstracted `Notifier` interface and queue. Patient channels (email/SMS/WhatsApp) can be added later as new providers                                      | Swap or add providers by price without touching callers                                                                                              |
| CI/CD and IaC             | GitHub Actions, Docker, Terraform/OpenTofu                                                                                                                                                                                                    | Free/cheap and reproducible                                                                                                                          |
| Observability             | Sentry + OpenTelemetry to a Grafana-based stack; structured logs with PHI scrubbing and capped retention                                                                                                                                      | Avoids Datadog-class bills early                                                                                                                     |
| Region                    | India (Mumbai) by default for data residency; per-tenant region later for foreign hospitals                                                                                                                                                   | Compliance and latency                                                                                                                               |

### Growth phases

1. **Dev and pilot (0 to a few hospitals):** everything runs locally in Docker; mock API until the backend exists. Deploy one small API container, a small managed Postgres (background jobs run on a Postgres-backed queue such as pg-boss), object storage, and the CDN-hosted SPA. Fixed, predictable monthly cost.
2. **Growth:** run containers on a managed orchestrator (ECS Fargate or Cloud Run) with autoscaling and at least 2 instances across zones; add a Postgres read replica and connection pooling (PgBouncer); add Redis for shared cache, rate limits and queues (BullMQ); separate worker containers for queues; put a WAF and per-tenant rate limits in front.
3. **Large scale:** partition big tables (appointments, invoices) by tenant/time, add more replicas, move the largest hospitals to dedicated databases, add multi-zone failover, and multi-region only if required.

### Cost guardrails

- Budget alerts from day one. Tag resources by environment and, where possible, by tenant. **Meter per-tenant usage** (requests, storage, active users) so hospitals can be priced and cost attributed.
- Autoscale with sensible min/max. Prefer ARM instances. Shut down non-prod outside working hours. Buy reserved capacity or savings plans only after 2 to 3 months of stable usage.
- Push work to the edge: CDN caching for static assets and non-PHI tenant config, cache reference data, compress responses, cap log retention, move old records and files to cheaper storage tiers.
- Self-host OSS (Keycloak, Grafana) only when ops time costs less than the SaaS bill. Otherwise use managed.
- Avoid until justified: Kubernetes, microservices, Kafka, paid UI component suites, per-seat enterprise SaaS.

### Production baseline (non-negotiable even when cheap)

- Encryption in transit and at rest, automated backups with point-in-time recovery, tested restores, and defined recovery targets.
- Immutable audit log of PHI access and changes, per tenant.
- Compliance: India DPDP Act by default; HIPAA/GDPR controls if serving those markets (signed BAA with hosting provider for US customers).
- Separate dev, staging, and production. **No real patient data outside production.**

### Frontend implications

- **One build for all hospitals.** No per-tenant builds or deploys. Differences are runtime config (tenant config, `AccessPolicy`, feature flags).
- All API calls go through the generated client. List endpoints return a cursor envelope: `{ items, nextCursor, total? }`.
- Only the static SPA is CDN-cached. Tenant config, `AccessPolicy` and all PHI responses are loaded after login, are private per session, and are never CDN-cached.
- Bandwidth is a cost: keep bundles small, lazy-load, and request only needed fields.
- Environment config via `VITE_` variables (non-secret): API base URL, Sentry DSN.
- Frontend and backend live in one monorepo with a single `CLAUDE.md`. Add a short `apps/api/CLAUDE.md` for backend-only rules (see Backend) once the backend starts.

## Performance Strategy

Goal: a fast, smooth, reliable application under heavy daily use. Capability comes first: pick the best library for each job and accept bundle weight where it earns its place. Performance is protected by code splitting, budgets, virtualization, caching and measurement, not by avoiding libraries.

### Targets

- **Devices and browsers:** mid-range hospital PCs (i3-class CPU, 8 GB RAM) on evergreen Chrome, Edge and Firefox (last 2 versions) over broadband or hospital LAN. No IE and no legacy builds. The login page and app shell must also remain usable on a throttled Slow 4G connection.
- **Budgets (gzipped, enforced in CI):** initial JS <= 300 KB, any route chunk <= 150 KB, heavy lazy chunks (calendar, charts, editor, PDF preview) <= 250 KB each and never in the initial load, and total CSS <= 60 KB. A PR that adds more than 30 KB to any chunk must say why.
- **Lighthouse** (desktop preset on mid-range CPU throttling, plus one Slow 4G run for login and the shell) on login, the patient list and the encounter screen: LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1, TBT <= 300 ms.
- **Memory:** page sizes of 25 to 100 rows (virtualize beyond about 100 rendered rows), React Query `gcTime` of 5 minutes, and a flat JS heap across a 30-minute soak test.
- **Requests:** at most 20 requests on first load. The session bootstraps in one request, and there are no request waterfalls before first render.

### Dependency policy

- There is no banned-library list. Use the best well-maintained library for the job, and prefer platform features (`fetch`, `Intl`, `URL`, `AbortController`, `structuredClone`, `BroadcastChannel`, `<dialog>`, CSS) when they are equally good.
- Rules: one library per job (do not mix two table, chart, form, date or component libraries); state the reason and the size impact from `pnpm analyze` in the PR; lazy-load heavy libraries so the initial load is unaffected; check the licence (MIT, Apache or BSD, no paid or premium plugins and no AGPL code in the shipped client without approval); require active maintenance and a clean `pnpm audit`; and avoid deprecated packages such as Moment on maintenance grounds.
- One design system: Tailwind and shadcn/ui (Radix) is the default. Adding another component suite (for example MUI) needs a clear reason, because mixing suites hurts consistency and bundle size.
- **Official documents and exports are generated on the server** (workers) for consistency and audit. Printing uses print CSS. CSV and report downloads use signed URLs.
- Prefer CSS for simple transitions and `motion` for complex ones. Clinical notes use the rich text editor.

### Build

- Vite `target: es2022` with no legacy plugin, and a `browserslist` that matches the device targets.
- Every route is lazy. Split only stable vendor libraries (react, react-dom, router, query) into a vendor chunk for long-term caching. Mark packages `sideEffects: false` and avoid wildcard re-exports of large modules.
- No source maps in production (upload them to the error tracker only). Strip `console` and `debugger` in production builds.
- Brotli at the CDN, immutable hashed assets, and `modulepreload` only for the critical login-to-app chunks.
- Non-critical code (Sentry, web-vitals) loads with a dynamic import after first paint (`requestIdleCallback`).
- CI fails when a budget is exceeded and reports the size change for each PR in the job summary (`scripts/bundle-budget.mjs`, where the budgets and the list of chunks allowed the heavy budget live). Run `pnpm analyze` for any PR that adds a dependency.

### Runtime and network

- No state is persisted to browser storage, and none is needed by default (see Stack).
- Lists use cursor pagination with page sizes of 25 to 100, TanStack Table for grids and TanStack Virtual for long lists and timelines. Never load a full dataset into the browser.
- Use sparse fieldsets (`fields=`) and compact payloads. List rows never fetch full records.
- HTTP caching: ETag and 304 for session policy and tenant config (private). Debounce, cancel and dedupe requests. Prefetch the next page and likely routes only on hover or when idle.
- Avoid re-render storms: colocate state, split contexts (session, tenant, policy), and memoize only after profiling.
- Images are SVG or WebP, lazy-loaded, and logos are capped at 50 KB.

### Backend and infrastructure

- Fastify. Containers use multi-stage builds, slim base images and ARM where available, with memory limits tuned from measurements (start at 512 MB per instance and raise it when metrics call for it).
- Phase 1 starts with few moving parts: one API container, Postgres, object storage and the CDN. Jobs run on a Postgres-backed queue and rate limits and cache are in-process. Introduce Redis (shared cache, rate limits, SSE fan-out across instances, BullMQ) as soon as profiling or a second API instance shows a benefit, which can be well before phase 2. Keep queue, cache and rate limiting behind interfaces so the swap is configuration.
- One database, one deployable and one region until metrics require more.
- Local Docker Compose uses profiles: the default profile runs only Postgres and Mailpit. `--profile full` adds MinIO (and Redis once it is needed). This keeps laptop RAM free.

## Repository Layout

```
hms/
  apps/
    web/             # React SPA (see Folder Structure)
    api/             # Fastify backend (see Backend)
  packages/
    contract/        # OpenAPI spec + generated types shared by web and api
  scripts/github/    # roadmap seeding and status
  docs/  .claude/  .github/
  CLAUDE.md  pnpm-workspace.yaml  package.json
```

- One repo, one issue tracker, one `CLAUDE.md`. API and UI changes for a feature land in the same PR.
- Run per-app scripts with filters: `pnpm --filter web dev`, `pnpm --filter api dev`. Root scripts (`pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`) run across all packages.
- `apps/web` imports types only from `packages/contract`. It never imports code from `apps/api`, and `apps/api` never imports from `apps/web`.
- Contract flow: the API generates `packages/contract/openapi.json` from its route schemas (`pnpm gen:api`), then the web client types are generated from it. CI fails if the committed spec is stale or has a breaking change without a version bump.

## Backend (apps/api)

- **Fastify + TypeScript**, run in dev with `tsx watch` (no build step). Production build with `tsup` or `tsc`.
- **TypeBox** route schemas give validation, TypeScript types and OpenAPI from one definition. Every route declares request and response schemas and its required permissions.
- **Drizzle ORM** with plain SQL migrations. Each migration is one new file, `apps/api/src/migrations/NNNN_what.sql`, applied in order by the API's own runner, which checksums every file and refuses to continue if an applied one was edited. (`drizzle-kit` is not used: its workflow rewrites a journal and fills in generated files, which conflicts with the rule that existing migrations are never modified.) RLS policies, the `tenant_id` convention and exclusion constraints are written as SQL in migrations. Migrations are additive. Backend-only rules are in `apps/api/CLAUDE.md`.
- **Postgres is the only required service in phase 1:** sessions, job queue (**pg-boss**), the transactional outbox and in-process rate limits all live in or beside it. Keep cache, queue and rate limiting behind interfaces so Redis (BullMQ) can replace them in phase 2.
- **Logging:** pino with a redaction config for PHI fields. Never log request or response bodies for patient routes.
- **Security:** `@fastify/helmet`, `@fastify/rate-limit` (per tenant and per user), `@fastify/cookie`, strict CORS, `@node-rs/argon2`, `otplib` for TOTP MFA.
- **Tests:** Vitest against a local Postgres database. Cross-tenant RLS tests are mandatory for every tenant table.

### Fastify plugin layout (one plugin per feature)

```
apps/api/src/
  app.ts            # builds the Fastify instance, registers core plugins and features
  core/
    config/  db/  session/  tenancy/  access/  audit/  outbox/  jobs/  notifier/
  features/<name>/
    index.ts        # exported Fastify plugin: registers routes, hooks, subscribers, jobs
    routes.ts       # TypeBox-schema routes, each with `permissions` and feature flag
    permissions.ts  # permission ids + default role grants
    schema.ts       # Drizzle tables (tenant_id on every table)
    events.ts       # published and subscribed domain events
    settings.ts     # per-hospital settings schema
  migrations/
```

Core hooks that every feature route passes through:

- **`session` hook:** authenticates the cookie session and binds the active tenant.
- **`tenant` hook:** opens a transaction per request and runs `SET LOCAL app.tenant_id = <session tenant>`. RLS then filters every query. The tenant is never taken from a client value.
- **`access` hook:** checks the tenant feature flag and the caller's permissions (and scope) declared on the route. Unlisted routes are denied.
- **`audit` hook:** records PHI reads and writes in the same transaction.
- **`outbox`:** domain events are written in the same transaction and dispatched by pg-boss.
  A feature registers as a Fastify plugin (encapsulated), so its decorators and hooks never leak into other features. Adding a feature is one new folder plus one registration line in `app.ts`.

## Package Manager

**pnpm only.** Never use `npm`, `yarn`, or `bun` for installing or running scripts, and never create or commit `package-lock.json` or `yarn.lock`.

- Install: `pnpm install` (CI: `pnpm install --frozen-lockfile`). Add: `pnpm add <pkg>` / `pnpm add -D <pkg>`. Remove: `pnpm remove <pkg>`.
- Run scripts: `pnpm <script>` or `pnpm run <script>`. Run a one-off binary: `pnpm dlx <tool>` (replaces `npx`).
- Commit `pnpm-lock.yaml`. Pin the version in `package.json` (`"packageManager": "pnpm@<version>"`) and the Node version in `.nvmrc`/`engines`, and enable it with `corepack enable`.
- Keep pnpm's strictness: do not hoist everything or set `shamefully-hoist` to silence a missing-dependency error. Declare the dependency instead.
- Dependency install scripts stay blocked unless explicitly approved in the pnpm config. Approving one needs a stated reason.
- **Development environment: native Windows** (PowerShell/Windows Terminal). WSL2 is not required. Docker Desktop uses it internally, which needs no action from developers.
- Keep the repo and pnpm store on the same drive, in a short path outside OneDrive or any synced folder (e.g. `C:\dev\hms`).
- **Scripts must be cross-platform.** No bash-only syntax in `package.json` scripts (no `rm -rf`, `export VAR=`, `&&`-chained shell tricks beyond simple cases). Use Node scripts, `cross-env`, `rimraf`, `cpy-cli`, or `tsx` instead. Ship `.gitattributes` with `* text=auto eol=lf` and use LF line endings everywhere.
- **Dev machine (HP 15s, i3-1115G4, 16 GB RAM, 2 cores):** use one editor, run Vitest with at most 2 workers, install only Chromium for local Playwright (CI covers other browsers), and keep Postgres native or Docker capped at 4 GB. Run heavy jobs (cross-browser e2e, load tests, production builds) in CI.
- Docker Compose services (Postgres and Mailpit by default, with MinIO and Redis through the `full` profile) use **named volumes** for data, not Windows bind mounts, for speed.
- The repo is a pnpm workspace (`pnpm-workspace.yaml` listing `apps/*` and `packages/*`). Use `pnpm --filter <app> <script>` for per-app work.

## Commands

```bash
pnpm dev        # start Vite dev server
pnpm build      # type-check + production build
pnpm lint       # ESLint
pnpm test       # Vitest
pnpm test:coverage  # Vitest with coverage thresholds for the foundation folders (what CI runs)
pnpm typecheck  # tsc --noEmit
pnpm analyze    # bundle size report (rollup-plugin-visualizer), writes apps/web/stats.html
pnpm budget     # check the built bundle against the budgets (run pnpm build first)
pnpm e2e        # Playwright end-to-end tests
pnpm gen:api    # regenerate typed API client from OpenAPI spec
```

## Folder Structure (apps/web, feature-based)

```
apps/web/src/
  app/              # router, providers (query client, session, tenant, policy, i18n), global error boundary
  tenancy/          # active tenant from session, tenant switcher, TenantProvider, useTenant, tenant config + theming
  access/           # permissions, AccessPolicyProvider, usePermission, <Can>, PermissionGuard
  registry/         # feature registry: collects feature manifests, builds routes + navigation
  features/
    auth/           # login, session slice, token handling, per-tenant SSO
    patients/       # registration, list, detail, edit
    doctors/        # doctors + departments
    appointments/   # scheduling, calendar, status changes
    clinical/       # visits, prescriptions, lab orders
    billing/        # invoices, payments
    dashboard/      # role-specific dashboards, reports
    platform/       # super-admin: manage hospitals/tenants (platform_admin only)
  shared/
    api/            # fetch wrapper with middleware, tenant-scoped query keys, generated/ (OpenAPI client)
    config/         # feature flags, constants
    ui/             # reusable components
    hooks/
    types/          # shared domain types
    utils/          # formatters (tenant-aware date/currency/timezone)
  routes/           # route generation from registry, PermissionGuard (lazy-loaded)
  mocks/            # MSW handlers
```

Each feature folder contains: `manifest.ts` (see Extensibility), `components/`, `hooks/` (React Query hooks), `api.ts`, `schemas.ts` (Zod), `types.ts`, `index.ts` (public exports). Features must not import from each other's internals, only via `index.ts` or `shared/`.

Path alias: `@/` maps to `apps/web/src/`. Backend structure is under Backend.

## Multi-Tenancy (multiple hospitals)

**Model:** each hospital is a tenant. Users belong to one or more tenants, with a role _per tenant_.

**Tenant resolution: single shared URL for all hospitals.** There are no per-hospital subdomains, paths, or builds. The tenant comes from the authenticated session, never from the URL.

- Users sign in at one login page (`app.hms.example.com`). The login page is generic and unbranded.
- After login the app calls `GET /session`, which returns the user, their memberships (hospital + role), the **active tenant**, tenant config, and `AccessPolicy`. Block rendering until it resolves.
- A user with one hospital goes straight in. A user with several (e.g. a doctor at two hospitals) sees a hospital picker, and can change hospital later from a tenant switcher in the header (`POST /session/switch-tenant`, which rebinds the session to the chosen tenant and returns the new config and policy).
- Only staff sign in. There is no patient login. A patient record belongs to exactly one hospital.
- Deep links (emails, notifications) use globally unique IDs. The server finds the owning tenant, checks the user's membership, and switches the active tenant if needed. If the user has no membership, show a 403 page, never the data.
- Optional later: remember the last-used hospital slug in `localStorage` (not PHI) only to pre-brand the login page.

**Tenant config** (fetched with the session after login, never hardcoded):

- Branding (name, logo, theme colors), locale/language, timezone, currency, date format
- Enabled modules/feature flags (e.g. lab module off for a small clinic)
- Auth settings (password login vs hospital SSO)
- Custom fields/forms if the product supports them later

**Rules:**

- The **active tenant lives in the server-side session**. The client may send `X-Tenant-ID` as a consistency check, and the API rejects the request if it doesn't match the session's active tenant (this catches stale tabs after a hospital switch). The backend derives and enforces tenant from the session and never trusts the client.
- Switching hospital in one tab affects the session in all tabs. Handle the mismatch response by reloading the session and showing a notice.
- **All React Query keys include `tenantId`** (e.g. `['tenant', tenantId, 'patients', 'list', filters]`). Use key factories only; no ad-hoc keys.
- On tenant switch or logout: clear the React Query cache, reset any global stores, abort in-flight requests.
- No hardcoded hospital names, currencies, date formats, timezones, or locales. Use tenant-aware formatters from `shared/utils`.
- Gate modules by tenant feature flags in both routes and navigation.
- MRN uniqueness is per tenant, not global.
- Test every feature with at least two tenants (see Testing).

## Extensibility and Access Control

Goal: add a feature later by adding a folder, and turn any feature or action on/off per hospital and per role through configuration, not code changes.

### Feature modules (plug-in architecture)

Every feature is a self-contained module that declares itself in `manifest.ts`:

```ts
export const patientsFeature: FeatureManifest = {
  id: 'patients',
  titleKey: 'nav.patients',
  featureFlag: 'patients', // tenant-level on/off
  routes: [
    { path: 'patients', lazy: () => import('./routes/PatientList'), requires: ['patient:read'] },
    {
      path: 'patients/new',
      lazy: () => import('./routes/PatientCreate'),
      requires: ['patient:create'],
    },
  ],
  nav: { icon: Users, order: 20, requires: ['patient:read'] }, // the lucide-react component, not a name
  permissions: ['patient:read', 'patient:create', 'patient:update', 'patient:delete'],
  extensions: [], // slot contributions (see Extension points)
  settings: undefined, // per-hospital settings schema (optional)
  dashboardWidgets: [], // optional
};
```

- `registry/` collects all manifests, drops those whose `featureFlag` is off for the current tenant, and generates **routes, navigation, and dashboard widgets** from what remains. No hand-edited route or menu lists.
- Adding a new feature = new folder + manifest + one line registering it in `registry/features.ts`. **No edits to core, routing, or other features.** The registry validates manifests at startup (duplicate ids or paths, undeclared permissions) and stops the app with the full list of problems.
- Route and slot modules loaded by a manifest **default-export** their component (the one exception to named exports), so `() => import('./routes/PatientList')` works with `React.lazy`.
- Features talk to each other only via `index.ts` exports, shared types, or registry extension points (e.g. a widget slot on the patient detail page), never by importing internals.
- Unreleased features ship dark behind a feature flag and are enabled per tenant.

### Permissions (not role names)

- Access is decided by **permissions** in `resource:action` form (`patient:read`, `billing:refund`, `labOrder:create`). Roles are just named bundles of permissions.
- **Never check role names in components or routes.** No `user.role === 'doctor'`. Use `usePermission('patient:update')` or `<Can permission="billing:refund">...</Can>`.
- A feature or action is available to a user only if **both** hold: the tenant has the feature flag on, **and** the user's role (in that tenant) has the permission.
- The effective policy is loaded from the backend at login/tenant boot (`AccessPolicy`) and held in `access/`. Changing a role's permissions or toggling a feature takes effect on next policy refresh with no redeploy. Refresh the policy on a timer and on 403 responses.
- Enforcement points in the UI: route guard (from `requires` in the manifest), nav item visibility, and action-level `<Can>` / `usePermission` for buttons, tabs, form fields, and table columns.
- Field-level restrictions (e.g. hide diagnosis from receptionists) use the same mechanism, e.g. `patient.diagnosis:read`.
- The backend remains the source of truth and enforces the same checks. UI gating is for experience, not security.

### Roles

Built-in roles (seed defaults): `platform_admin` (cross-tenant), `admin` (hospital admin), `doctor`, `nurse`, `receptionist`, `pharmacist`, `lab_technician`, `radiologist`, `store_keeper`. There is no patient role: patients are data, not users. Each hospital's admin can **adjust permissions of built-in roles and create custom roles** (e.g. `billing_clerk`, `insurance_officer`, `ot_coordinator`, `ward_clerk`, `blood_bank_technician`) through a role management screen. Roles are scoped to a tenant, except `platform_admin`.

Default matrix (seed data only; the live policy comes from the backend):

| Area                                  | platform_admin | admin        | doctor          | nurse          | receptionist  | pharmacist    | lab_technician | radiologist | store_keeper |
| ------------------------------------- | -------------- | ------------ | --------------- | -------------- | ------------- | ------------- | -------------- | ----------- | ------------ |
| Manage hospitals/tenants              | yes            | no           | no              | no             | no            | no            | no             | no          | no           |
| Users, roles, master data             | yes (tenants)  | own hospital | no              | no             | no            | no            | no             | no          | no           |
| Patient registration and demographics | no*            | yes          | yes             | yes            | register/edit | view          | view           | view        | no           |
| Appointments and queue                | no*            | yes          | own schedule    | view           | create/edit   | no            | no             | no          | no           |
| Triage and vitals                     | no*            | view         | view            | record         | no            | no            | no             | no          | no           |
| Clinical notes, diagnosis, orders     | no*            | view         | yes             | limited        | no            | no            | no             | no          | no           |
| Lab (collect, result, verify)         | no*            | view         | view results    | collect        | no            | no            | yes            | no          | no           |
| Imaging (perform, report)             | no*            | view         | view results    | no             | no            | no            | no             | yes         | no           |
| Pharmacy dispense and sales           | no*            | view         | no              | request/indent | no            | yes           | no             | no          | no           |
| Inventory and purchasing              | no*            | view         | no              | indent         | no            | stock view    | no             | no          | yes          |
| Admissions and beds (ADT)             | no*            | yes          | admit/discharge | transfer/view  | admit desk    | no            | no             | no          | no           |
| Nursing care (MAR, notes)             | no*            | view         | view            | yes            | no            | no            | no             | no          | no           |
| Billing and payments                  | no*            | yes          | view            | no             | yes           | counter sales | no             | no          | no           |
| Insurance and claims                  | no*            | yes          | no              | no             | create/view   | no            | no             | no          | no           |
| Reports                               | no*            | all          | own             | ward           | desk          | pharmacy      | lab            | imaging     | stock        |

\*Platform admins manage tenants but do **not** get default access to patient data. Any support access must be explicit, audited, and time-limited.

Scope rules such as "own patients only" or "own schedule" (for doctors) are data-scope constraints evaluated by the backend and surfaced to the UI as part of the policy (e.g. `scope: 'own'`). Do not reimplement them on the client.

In v1 the system does not contact patients (no SMS, email, WhatsApp, or reminders). Patient messaging is deferred and must be addable as a feature module. See "Adding a new feature later".

### Adding a new feature later

Any new feature (appointment reminders, insurance, inventory, reports, anything) must be addable **without editing core modules**. The mechanisms below are part of the foundation (step 0), not afterthoughts.

**Rules**

- Dependency direction is one-way: feature modules depend on `shared/` and core public APIs. Core never imports a feature.
- A feature adds itself through five hooks only: a **manifest** (routes, nav, permissions, flag), **extension slots** (UI contributions to existing screens), **domain events** (reacting to what core does), its **own tables** (additive migrations), and **per-hospital settings**.
- Core changes allowed for a new feature are strictly additive: nullable columns, new events, new slots. Never change the meaning of existing fields.
- Every feature ships dark behind a feature flag, off by default, enabled per hospital by `platform_admin`, with its permissions registered and default role grants seeded.

**Extension points (slots)**
Core screens render slots, and features contribute components to them through `manifest.extensions`. The registry resolves contributions by slot, feature flag, and permission. Initial slots: `patient.detail.tabs`, `patient.detail.actions`, `patient.form.fields`, `appointment.form.fields`, `appointment.row.badges`, `appointment.row.actions`, `dashboard.widgets`, `settings.sections`, `nav.items`. Add a new slot to core only when a real feature needs one, as an additive change.

**Domain events (backend contract)**
Core modules publish events through a transactional outbox (written in the same database transaction, then delivered to the queue) so subscribers never miss or duplicate-trigger on rollbacks. Initial events, each carrying `tenantId`, entity ID, actor, and timestamp:

- `patient.registered`, `patient.updated`
- `appointment.created`, `appointment.rescheduled`, `appointment.cancelled`, `appointment.completed`, `appointment.no_show`
- `encounter.opened`, `encounter.closed`, `queue.token_issued`, `queue.called`, `vitals.recorded`
- `order.placed`, `order.cancelled`, `order.completed`
- `lab.sample_collected`, `lab.result_verified`, `lab.critical_value`, `imaging.reported`
- `pharmacy.dispensed`, `stock.low`, `stock.expiring`
- `charge.posted`, `invoice.issued`, `invoice.paid`, `payment.refunded`
- `admission.created`, `bed.assigned`, `bed.released`, `medication.administered`, `discharge.completed`
- `er.triaged`, `surgery.completed`, `claim.submitted`, `claim.settled`

New features subscribe to events in their own module. They do not modify the module that emits them. Handlers must be idempotent.

**Per-hospital feature settings**
A feature declares `settings` (a Zod schema + permission) in its manifest. The hospital admin settings screen renders a section for each enabled feature. Values are stored per tenant (`tenant_feature_settings`, JSON validated against the schema) and delivered to the frontend with the tenant config.

**Backend module shape** (Fastify plugin, one per feature, see Backend)

```
apps/api/src/features/<name>/
  index.ts        # Fastify plugin: routes, hooks, event subscribers, jobs
  routes.ts       # TypeBox schemas, permissions and feature flag per route
  permissions.ts  # permission ids + default role grants
  schema.ts       # Drizzle tables (tenant_id + RLS via migration)
  events.ts       # subscribed + published events
  settings.ts     # per-hospital settings schema
```

The core `access` hook checks the tenant's feature flag and the caller's permissions on every route of the plugin.

**Checklist for any new feature**

1. Define permissions and default role grants. Add the feature flag (off by default).
2. Backend module: tables (with `tenant_id` + RLS), API with OpenAPI, event subscribers, workers, metering/quota if it costs money.
3. Frontend: `apps/web/src/features/<name>/` with `manifest.ts`, routes, slot contributions, settings section, MSW handlers.
4. Tests: happy path, flag off, permission absent, two tenants, idempotent event handling.
5. Enable for one pilot hospital, then roll out.

**Worked example: appointment reminders (planned, not in v1)**
Nothing in core changes. The feature adds:

- Backend `reminders` module subscribing to `appointment.created|rescheduled|cancelled`. It schedules or cancels delayed jobs, checks `patient.contactConsent`, renders a hospital-specific template, and sends through the `Notifier` interface using email/SMS/WhatsApp providers. It meters messages per hospital against a quota and honors opt-outs.
- Frontend `features/reminders/`: a settings section (channels, timing, templates, quota), an `appointment.row.badges` contribution ("reminder sent/failed"), and a `reminder:manage` permission.
- Messages contain minimum necessary information (date, time, hospital name) and never diagnoses or department names that reveal a condition.
- What v1 must already provide for this: the appointment events, the `Notifier` abstraction, patient phone/email/`contactConsent` captured at registration, the slot and settings mechanisms, and feature flags with per-tenant settings.

### Hospital onboarding (platform_admin)

`platform_admin` is the built-in role for the product owner/operators and is the only role that can onboard hospitals. It is not scoped to any hospital, uses the `features/platform/` module, and has **no access to patient data** by default.

Onboarding flow, all in the platform module:

1. **Create hospital:** name, slug, locale, timezone, currency, branding (logo, primary color), region.
2. **Choose plan/features:** enable or disable modules (feature flags) for this hospital, and set limits (e.g. max users, storage).
3. **Seed roles:** the built-in roles are created for the new hospital with default permissions (editable later by its admin).
4. **Invite first hospital admin:** enter the admin's name and email. The system sends an invite link. The admin sets a password and MFA, then signs in and invites their own staff.
5. **Activate:** the hospital goes live. It can later be suspended (blocks all logins, keeps data) or offboarded (export, then scheduled deletion).

Rules:

- The first `platform_admin` is created by a seed script or CLI at deploy time, never through the UI or public sign-up. Require MFA for all platform admins.
- Platform admins can create or edit a hospital's config and invite its first admin, but cannot view patient records, appointments, clinical data, or billing.
- Any exceptional support access to a hospital's data must be explicit, time-limited, approved by that hospital's admin, and written to the audit log.
- Every platform action (create, suspend, feature toggle, impersonation if ever allowed) is audit-logged.
- A hospital admin can only manage users and roles within their own hospital.

## Domain Types

```ts
// Roles are data, not a closed union: hospitals can create custom roles.
export type RoleId = string;
export const BuiltInRoles = {
  PlatformAdmin: 'platform_admin',
  Admin: 'admin',
  Doctor: 'doctor',
  Nurse: 'nurse',
  Receptionist: 'receptionist',
  Pharmacist: 'pharmacist',
  LabTechnician: 'lab_technician',
  Radiologist: 'radiologist',
  StoreKeeper: 'store_keeper',
} as const;

export type Permission = `${string}:${string}`; // 'resource:action'
export type PermissionScope = 'all' | 'own' | 'department';

export interface RoleDefinition {
  id: RoleId;
  tenantId: string | null; // null for platform-level roles
  name: string;
  builtIn: boolean;
  permissions: { permission: Permission; scope?: PermissionScope }[];
}

export interface AccessPolicy {
  tenantId: string;
  roleId: RoleId;
  permissions: { permission: Permission; scope?: PermissionScope }[];
  features: Record<string, boolean>; // tenant feature flags
  version: string; // for cache invalidation/refresh
}

// A dynamic import of a module whose default export is the component.
export type LazyComponent<Props = object> = () => Promise<{ default: ComponentType<Props> }>;
// What a host screen passes to slot contributions: ids and values, never whole records.
export interface SlotProps {
  context?: Readonly<Record<string, unknown>>;
}

export interface FeatureManifest {
  id: string;
  titleKey: string; // a key in i18n.titles (or in core `common` for a feature with no i18n)
  // The feature's own translations. `titles` (nav and settings titles, per language, English
  // required) are bundled with the manifest. `load` fetches the screen strings on demand into a
  // namespace named after the feature id: useTranslation('patients').
  i18n?: {
    titles: { en: Record<string, string> } & Record<string, Record<string, string>>;
    load: (language: string) => Promise<{ default: object }>;
  };
  featureFlag: string;
  // path is relative, without a leading slash
  routes: { path: string; lazy: LazyComponent; requires: Permission[] }[];
  // icon is the component itself so it tree-shakes; path defaults to the first route
  nav?: {
    icon: ComponentType<{ className?: string }>;
    order: number;
    requires: Permission[];
    path?: string;
  };
  permissions: Permission[]; // everything used in a requires must be declared here
  extensions?: {
    slot: SlotId;
    component: LazyComponent<SlotProps>;
    requires?: Permission[];
    order?: number;
  }[];
  settings?: { section: string; schema: unknown /* Zod schema */; requires: Permission[] };
  // shorthand for contributions to the dashboard.widgets slot
  dashboardWidgets?: {
    id: string;
    component: LazyComponent<SlotProps>;
    requires?: Permission[];
    order?: number;
  }[];
}

export type SlotId =
  | 'patient.detail.tabs'
  | 'patient.detail.actions'
  | 'patient.form.fields'
  | 'appointment.form.fields'
  | 'appointment.row.badges'
  | 'appointment.row.actions'
  | 'dashboard.widgets'
  | 'settings.sections'
  | 'nav.items';

export interface Tenant {
  id: string;
  slug: string;
  name: string;
  locale: string; // e.g. 'en-IN'
  timezone: string; // IANA, e.g. 'Asia/Kolkata'
  currency: string; // ISO 4217
  theme: { primary: string; logoUrl?: string };
  features: Record<string, boolean>;
  auth: { mode: 'password' | 'sso' };
  status: 'active' | 'suspended'; // suspended: data kept, staff see the suspended page
}

export interface User {
  id: string;
  email: string;
  name: string;
  memberships: { tenantId: string; tenantName: string; roleId: RoleId }[]; // tenantName feeds the hospital picker
}

// Every tenant-owned entity carries tenantId.
export interface Patient {
  id: string;
  tenantId: string;
  mrn: string; // medical record number, unique per tenant
  firstName: string;
  lastName: string;
  dob: string; // ISO date
  gender: 'male' | 'female' | 'other';
  phone: string;
  email?: string;
  address?: string;
  contactConsent?: { given: boolean; at: string; recordedBy: string }; // captured at registration; used by future messaging features
}

export interface Department {
  id: string;
  tenantId: string;
  name: string;
}

export interface Doctor {
  id: string;
  tenantId: string;
  userId: string;
  departmentId: string;
  specialization: string;
}

export interface Appointment {
  id: string;
  tenantId: string;
  patientId: string;
  doctorId: string;
  startsAt: string; // ISO datetime (UTC); display in tenant timezone
  status: 'scheduled' | 'completed' | 'cancelled' | 'no_show';
  reason?: string;
}

// The spine of care. Everything clinical, ordered or billed attaches to an encounter.
export interface Encounter {
  id: string;
  tenantId: string;
  patientId: string;
  type: 'opd' | 'ipd' | 'er' | 'daycare';
  status: 'open' | 'closed' | 'cancelled';
  appointmentId?: string;
  attendingDoctorId?: string;
  departmentId?: string;
  openedAt: string;
  closedAt?: string;
}

export interface Order {
  id: string;
  tenantId: string;
  encounterId: string;
  type: 'lab' | 'imaging' | 'procedure' | 'medication' | 'diet';
  catalogItemId: string; // service, drug or test from master data
  status: 'placed' | 'accepted' | 'in_progress' | 'completed' | 'cancelled';
  priority: 'routine' | 'urgent' | 'stat';
  orderedBy: string;
  placedAt: string;
  details?: Record<string, unknown>; // dosage and frequency for medication, notes, etc.
}

export interface Charge {
  id: string;
  tenantId: string;
  encounterId: string;
  serviceId: string;
  source: 'service' | 'order' | 'dispense' | 'bed' | 'procedure' | 'manual';
  sourceRef?: string;
  quantity: number;
  unitPriceMinor: number; // minor currency units, from the price list effective at posting time
  status: 'pending' | 'invoiced' | 'void';
  postedAt: string;
}

export interface Invoice {
  id: string;
  tenantId: string;
  patientId: string;
  encounterId?: string;
  chargeIds: string[];
  totalMinor: number;
  currency: string;
  status: 'draft' | 'issued' | 'paid' | 'void';
  issuedAt?: string;
}
```

**Other entities (defined with their module, each carrying `tenantId` and `id`, and referencing `encounterId` or `patientId` where relevant):**

- Master data: `Service`, `PriceList` (effective-dated), `Drug`, `LabTest` (with reference ranges), `Ward`, `Room`, `Bed`, `DiagnosisCode`, `Template`.
- Front desk and OPD: `QueueToken`, `Vitals`, `ClinicalNote`, `Prescription`, `Referral`.
- Diagnostics: `LabSample`, `LabResult` (versioned, verified), `ImagingReport`.
- Pharmacy and stores: `StockItem`, `Batch`, `StockLedgerEntry` (append-only), `Supplier`, `PurchaseOrder`, `GoodsReceipt`, `Dispense`, `Indent`.
- Inpatient: `Admission`, `BedAssignment` (history), `MedicationAdministration` (append-only), `ProgressNote`, `DischargeSummary`, `Deposit`.
- Specialty: `ErEncounter`, `Surgery`, `OtBooking`, `Insurer`, `Policy`, `PreAuth`, `Claim`.
- Records and operations: `Document`, `Consent`, `Certificate`, `Roster`, `BloodUnit`, `AmbulanceTrip`.

## Build Order

The detailed plan is `docs/ROADMAP.md` (generated from `scripts/github/roadmap.mjs`), organized in milestones and the four releases in Product Scope. In short:

- **R1:** Setup -> Foundation (tenant, access, registry, shell) -> Auth -> Patients -> Doctors and staff -> **Master data** -> Appointments, queue and triage -> OPD clinical and orders -> Laboratory -> Radiology -> Pharmacy and inventory -> Billing -> Reports -> Platform admin -> Roles -> Hardening and pilot launch.
- **R2:** Bed management and admissions -> Nursing and ward care -> Discharge and IPD billing.
- **R3:** Emergency -> Operation theatre -> Insurance and claims.
- **R4:** Medical records and documents -> Operations (rosters, blood bank, ambulance, housekeeping).

Complete and test one module before starting the next. Ship each release to a pilot hospital before starting the next, and run the hardening checklist at the end of every release. Build master data and the encounter, order and charge foundations before any module that depends on them.

## Scalability

### Frontend performance

- **Code splitting:** lazy-load every route with `React.lazy` + `Suspense`. Split heavy libs (charts, calendar, PDF) into separate chunks.
- **Bundle budgets:** initial JS <= 300 KB gzipped, each route chunk <= 150 KB, heavy lazy chunks <= 250 KB, CSS <= 60 KB (see Performance Strategy). Fail CI if exceeded. Check with `pnpm analyze`.
- **Lists:** never render unbounded lists. Use **server-side** pagination (prefer cursor-based), filtering, and sorting, with page sizes of 25 to 100, TanStack Table for grids and TanStack Virtual beyond about 100 rendered rows. Debounce search inputs (300 ms) and cancel stale requests.
- **React Query tuning:** set sensible `staleTime` per data type (reference data like departments: minutes; live data like appointment slots: seconds). Use `placeholderData`/`keepPreviousData` for pagination, prefetch likely next views, and rely on request dedupe. Use optimistic updates where safe.
- **Avoid over-fetching:** request only needed fields/pages. No fetch-all-then-filter-client-side. No polling loops without backoff. Prefer SSE/WebSocket only for truly live views (queues, bed status), and keep them scoped to a tenant channel.
- **Rendering:** memoize expensive components, keep state local, avoid wide context re-renders, split contexts (session, tenant, policy). Profile before optimizing.
- **Assets:** hashed filenames with long-lived immutable caching, served from a CDN. Compress (brotli), lazy-load images, use modern formats.
- **Do not cache PHI** in service workers, CDN, or persistent browser storage.

### Resilience under load

- API client: timeouts, retry with exponential backoff + jitter for idempotent requests only, and respect `Retry-After` on **429**. Show a friendly "busy, retrying" state.
- Cancel in-flight requests on navigation/unmount (`AbortController`).
- Error boundaries per route and per widget so one failure doesn't blank the app.
- Graceful degradation: if a non-critical widget fails (e.g. dashboard chart), the rest of the page still works.
- Idempotency keys on create/payment mutations to prevent duplicates on retry or double-click.
- Disable submit buttons while mutations are pending.

### Platform and backend expectations (see Technology Decisions)

- Stateless API behind a load balancer, horizontally scalable; static frontend on a CDN.
- `tenant_id` on every table, enforced with PostgreSQL row-level security (or equivalent); composite indexes starting with `tenant_id`.
- Read replicas for reporting/read-heavy endpoints; Redis (from phase 2) for shared caching and rate limiting; job queue + workers for slow jobs (report generation, bulk billing, staff email).
- **Per-tenant rate limits and quotas** so one busy hospital cannot degrade others (noisy-neighbor protection).
- Cursor-based pagination and server-side search (indexes/search engine) for large tables.
- Frontend can assume list endpoints return `{ items, nextCursor, total? }`.

### Monitoring

- Report Core Web Vitals (LCP, INP, CLS) tagged by tenant and route (no PHI).
- Track API error rate and p95 latency per tenant.
- Lighthouse CI and bundle-size checks on every PR.

## Conventions

- **Access checks:** only via `usePermission`, `<Can>`, or manifest `requires`. Never compare role names. Never hardcode which role sees what.
- **State:** server data (including session, tenant config and policy) goes through React Query and is never copied into Redux. Redux Toolkit holds client and workflow state only, and every slice resets on tenant switch and logout. Local component state for everything else. Never persist PHI to browser storage.
- **Query keys:** centralized per feature via key factories, always prefixed with tenant (e.g. `patientKeys.list(tenantId, filters)`). Invalidate precisely after mutations.
- **Forms:** every form uses React Hook Form + a Zod schema. Derive form types with `z.infer`. Labels and validation messages go through i18n.
- **Typing:** no `any`. Prefer `unknown` + narrowing. API responses are validated or typed at the `api.ts` boundary.
- **Components:** function components, named exports, small and single-purpose. Co-locate styles and tests.
- **Naming:** `PascalCase` components, `camelCase` functions/vars. Be consistent with existing files.
- **Async UI:** every data view handles loading, empty, and error states.
- **Dates and money:** store and transmit ISO strings (UTC) and minor-unit/decimal-safe amounts. Format only at the display layer using tenant locale, timezone, and currency.
- **i18n:** no user-facing string literals in components. Use translation keys. Core strings live in `app/locales/<language>/common.json`. A feature keeps its strings in its own folder and declares them in `manifest.i18n`, never in core locale files. The UI language follows the active hospital's locale (`hi-IN` uses the `hi` files) and falls back to English per language and per key. Tests fail on any rendered key that has no translation.
- **Errors:** centralize API error handling in the API client wrapper. Surface user-friendly messages, never raw server errors.
- **Accessibility:** semantic HTML, labelled inputs, keyboard-navigable tables and dialogs.

## Security and Privacy (healthcare data)

- Treat all patient data as sensitive PHI.
- **Tenant isolation is a security boundary.** Never derive authorization from client-supplied tenant values. Clear all cached data on tenant switch/logout.
- Never log PHI to the console, error trackers, or analytics. Configure the error tracker to scrub PHI.
- **Error reporting and logging policy** (web: `app/observability/`, `shared/lib/logger.ts`):
  - Errors only. No session replay, no performance tracing, no breadcrumbs. The SDK loads after first paint, and only when `VITE_SENTRY_DSN` is set for the deployment.
  - Every outgoing event is **rebuilt from an allowlist** (`scrubEvent`): error type, stack frames (file, function, line), environment, release, and two tags, the route pattern and the tenant id. Request and response bodies, URLs, query strings, headers, cookies, the user, and any extra data are never sent.
  - **Error messages are not sent**, because code builds them from data. The one exception is `ApiError`, whose message is always a fixed code. Do not put information you need for debugging in an error message; use the error type and a stable code.
  - Report a caught error with `reportError(error)`. Never attach context objects to it.
  - App code does not call `console.*` (lint error). Use `logger.warn(event, fields)` or `logger.error(event, fields)`: a static event name plus fields from the `LogFields` allowlist (tenant id, route pattern, feature, code, status, request id, key, count, duration). Adding a field is a reviewed change to `LogFields`, where "can this ever hold patient data?" is asked once.
  - Web vitals carry the metric, its rating, the route pattern and the tenant id only.
- Do not store PHI in `localStorage`/`sessionStorage`. Prefer in-memory state. Prefer httpOnly cookies for tokens if the backend supports it. Otherwise keep the access token in memory only.
- Auto-logout on inactivity (configurable per tenant). Clear React Query cache on logout.
- Mask sensitive fields where full values are not needed (e.g. phone, MRN in lists).
- Audit-relevant actions (view/edit patient record, billing changes) must be sent through the API so the backend can log them per tenant.
- Never hardcode secrets. Use `.env` (git-ignored) with `VITE_` prefix only for non-secret config.
- Sanitize anything rendered from user input. No `dangerouslySetInnerHTML`.
- Apply a strict Content-Security-Policy and standard security headers at the CDN/host.

## Testing

- Unit/component tests for forms, guards, and hooks with Vitest + RTL.
- Mock the network with MSW, not by mocking fetch.
- Each feature ships with tests for: happy path, validation errors, permission-based visibility.
- **Multi-tenant tests:** verify cache isolation when switching tenants, tenant-scoped query keys, tenant-specific theming/locale/feature flags, and that disabled modules are unreachable.
- **Access tests:** for each feature, test with permission present, permission absent, feature flag off, and a custom role. Verify hidden nav/routes/actions and 403 handling. Verify policy refresh updates the UI without reload.
- **Performance tests:** Lighthouse CI + bundle budgets in CI; tests with large result sets (10k+ total rows) confirm pagination keeps the page responsive and memory flat.
- Run k6 or similar load tests against staging from a cloud runner, not the laptop per tenant and with mixed tenants.
- **Foundation coverage is enforced.** CI runs `pnpm test:coverage`, which fails if line, branch, function or statement coverage of `access/`, `tenancy/`, `registry/`, `shared/api/` and `app/session/` drops below the thresholds in `apps/web/vitest.config.ts`. A change to those folders ships with its tests. Lower a threshold only with a stated reason.
- Run `pnpm lint && pnpm typecheck && pnpm test` before considering a task done.

## Workflow (GitHub issues)

Issues are the source of truth for scope and progress. The roadmap is defined in `scripts/github/roadmap.mjs` (see `docs/ROADMAP.md` and `docs/WORKFLOW.md`).

- Work on **one issue at a time**. Issue titles start with an ID such as `[F-03] Session bootstrap`. Read the issue with `gh issue view <n>`, including its tasks, acceptance criteria and dependencies. Confirm its dependencies are closed before starting.
- **Plan first** for any issue sized M or L: present a short plan and wait for approval.
- **Branches:** `feat/<n>-<slug>`, `fix/<n>-<slug>`, `chore/<n>-<slug>`. **Commits:** Conventional Commits with the issue number, e.g. `feat(patients): add search (#42)`. **PRs:** one issue per PR, body ends with `Closes #<n>`. Merging closes the issue; never close issues by hand.
- **Do not widen scope.** Anything discovered but out of scope becomes a proposed new issue (title, labels, milestone, tasks), not part of the current change.
- Labels: `type:*`, `area:*`, `P0`-`P2`, `size:S|M|L`, `status:in-progress|in-review|blocked|needs-decision`. Never mark an issue `status:blocked` without stating the blocker in a comment.
- Done means the issue's Definition of Done is satisfied, including `/tenant-safety-check` and `/phi-check` where data or access is touched.
- Backend work (`area:backend`) lives in `apps/api` of this same repo. Frontend issues build against the MSW mock and the OpenAPI contract until the matching backend issue is done. A feature's frontend and backend issues may share one PR when they are small.

## Working Agreement for Claude

- Follow the build order and the Workflow (GitHub issues) section for every task. Ask before changing the stack or folder structure.
- Make small, reviewable changes. Explain non-obvious decisions briefly.
- Reuse existing shared components and types before creating new ones.
- When adding a feature, create: types (with `tenantId`), Zod schema, API functions, tenant-scoped React Query hooks, components, a `manifest.ts` (routes, nav, permissions, feature flag), MSW handlers, and tests (including multi-tenant and permission cases). Register it in the registry; do not edit core routing or other features.
- For any clinical or financial module, run `/module-integration-check`: it must use `Encounter`, the unified `Order`, the charge ledger and domain events as described in Product Scope, never its own parallel concepts.
- Define new permissions in the feature manifest and gate every action with `usePermission`/`<Can>`.
- Before changing a core module for a new requirement, check whether it can be done as a feature module, extension slot, or event subscriber. Core changes must be additive.
- Any list view must use server-side pagination; never load all records.
- Do not add dependencies without stating why and checking bundle impact. Use pnpm for every install and script run.
- Prefer the decided stack and free/open-source tools. Any paid service or dependency needs an explicit justification and a cheaper alternative noted.
- Never create per-tenant builds or branches. Tenant differences are runtime configuration.

## Open Decisions

Decided defaults live in Technology Decisions. Remaining questions:

- Backend: Fastify + TypeBox + Drizzle decided. Revisit NestJS only if a team joins and wants enforced structure and dependency injection
- Whether any premium library licence (for example a calendar resource timeline or an advanced data grid) is worth buying for the scheduling and OT views
- Exact numeric budgets: the initial values in Performance Strategy are starting points to tighten or relax after the first real measurements
- Cloud provider: AWS Mumbai assumed. Alternatives (GCP, Azure, a cheaper VPS provider for the pilot phase) if cost or credits favor them
- Target markets and compliance scope: India DPDP only vs HIPAA/GDPR, and per-tenant data residency
- When per-hospital SSO (Keycloak, SAML/OIDC) is first needed
- Permission granularity: resource:action only (assumed) vs field-level and attribute-based (ABAC) rules
- Who can create custom roles (hospital admin only vs platform-approved) and whether permissions can be time-boxed
- Policy delivery: fetched at login + refresh (assumed) vs embedded in token; refresh interval
- Dynamic module loading: build-time registry (assumed) vs runtime micro-frontends (Module Federation) if independent team deployments are needed
- Whether any hospital will ever need its own branded URL or custom domain (not planned; single shared URL by default)
- Login-page branding before sign-in (generic by default; optional last-used-hospital memory)
- Real-time needs (queues, bed availability) and whether SSE is enough
- Integrations to plan adapters for: ABDM/ABHA, HL7 v2 or FHIR, lab analyzers, DICOM/PACS, insurer and TPA e-claim portals, accounting export (for example Tally)
- Statutory and regional requirements: drug schedule and controlled-drug registers, GST invoice formats, death and birth certificate formats, medico-legal records
- Whether telemedicine, a patient portal or a mobile app for doctors are ever in scope (currently out of scope)
- Which modules the pilot hospital actually needs in R1, so low-priority modules (radiology, purchasing) can be deferred
