# Hospital Management System (HMS)

## Overview

Permission-based, **multi-tenant** web app serving **multiple hospitals** from one deployment: an **end-to-end HMS** covering the whole patient journey from arrival to exit (OPD, inpatient, emergency, diagnostics, pharmacy, billing, insurance and records). See Product Scope. Must handle **very high traffic** (many hospitals, many concurrent users). A **pnpm monorepo**: the React SPA (`apps/web`), the Fastify API (`apps/api`) and the shared contract (`packages/contract`). The web app runs against an MSW mock API by default; what the real API covers is in Current Status.

**Staff-only application.** Only hospital staff (and platform admins) have accounts. Patients are records managed by staff: no patient login, portal or self-service, and in v1 nothing contacts a patient (no SMS, email, WhatsApp or reminders). Reminders are planned as a plug-in module that needs no change to core code (`docs/EXTENDING.md`).

Five non-negotiables shape every decision:

1. **Tenant isolation:** one hospital must never see another hospital's data or config.
2. **Scale:** performance and resilience are features, not afterthoughts.
3. **Extensibility and configurable access:** new features plug in without touching core code, and any feature or action can be enabled/disabled per hospital and per role without a redeploy.
4. **Production-grade but cheap:** proven open-source technology, a small fixed cost to start, and cost that grows with usage rather than ahead of it. See Technology Decisions and Cost Strategy.
5. **Fast and effective:** the product must feel instant and stay correct under load. Choose the best proven tool for each job rather than the smallest one. Weight is accepted when it buys real capability, and it is controlled with code splitting, budgets and measurement. See Performance Strategy.

## Current Status

As of 2026-10-19. GitHub issues and milestones are the source of truth (`gh issue list --milestone "<name>"`); update this section when a milestone closes. A finished module gets an entry in `docs/STATUS.md` and its name under What exists; what was decided for it goes in the feature folder's own `CLAUDE.md`, not here.

- **M0 Setup:** done.
- **M1 Foundation:** done, except #264 (the idle sign-out test fails intermittently on a slow machine; it passes in CI).
- **M2 Auth and access:** done. Open follow-ups: #252, #253, #254, #255, #257 (the account API).
- **M3 Patients:** done in both apps (#49 to #55). Open: #56 (staging and deploy, deferred until a cloud account exists) and #259 (search for very large hospitals, a spike).
- **M4 Doctors, departments, staff:** done, in the web app and the API (#57 to #61, #276). Leave and one-off changes to working hours belong with appointments.
- **M5 Master data and catalogs:** every catalog and the import centre done in both apps (#62 to #69, #286, #289, #298 to #303). Open: #304 (which code sets the pilot loads) and #310.
- **M6 Appointments, queue and triage:** appointments done in both apps: list, calendar, booking and status changes (#70 to #73), the API (#75) and the end-to-end tests (#74). The OPD token queue (#76) and triage (#77) in both apps, with their API (#79). Open: the waiting-room display (#78) and the vital sign range follow-ups (#378, #379).
- **M7 and beyond:** not started. No clinical or billing module exists yet.

**What exists**

Done in the web app and the API: patients, departments, doctors, staff, and every master data catalog (services and prices, drugs, lab tests, wards, codes, templates) with the import centre, appointments (list, calendar, booking, status changes), the OPD token queue (issuing, and a live board over server-sent events) and triage (vitals, chief complaint, allergies). Sixteen features are registered, with `notices` the template for new modules. Exports another module may use: `PatientSearch`, `usePatientName` and `DetailTab` (patients), `useDepartmentOptions`, `useServiceOptions`, `CodeSearch`, `fillPlaceholders` and `placeholdersIn` (templates), `TriageSummary` (triage), and `app.importKinds` on the API. Each module's entry (switch, permissions, exports), what `db:seed` loads for it, and the known gaps are in `docs/STATUS.md`. What was decided for a module, and its own gaps, is in `apps/web/src/features/<folder>/CLAUDE.md`, which Claude Code loads when a file of that folder is read. **Read it before changing the module in either app:** for work under `apps/api` it does not load by itself.

**Against the real API** every module done in both apps works, with sample data from `db:seed`. Mock only: `notices`, change password, the account sessions and `POST /session/open-link`, which are in the planned contract (`packages/contract/planned.openapi.json`); the real policy lists only permissions the API knows, so other feature screens show "no access" there.

**Not built yet, although described below as the target**

- API: `@fastify/helmet` and CORS; the role management API (BE-16, roles are read-only for the app until then); object storage. Server-sent events exist for the queue board only (`core/live`).
- Web: every clinical and billing feature, the platform admin module.
- Platform admins: the `is_platform_admin` flag exists, but there is no way to create one, no platform routes, and MFA is not yet enforced for them.
- Deployment: no infrastructure code and no hosted environment. CI builds the API image and runs the tests.

**Known gaps** (detail in `docs/STATUS.md`): the authenticator is off for a hospital until its `mfa` switch (and `mfa_required` to make it compulsory) is set in `tenant_features`, with no screen for the switches yet; the account page's endpoints and disabling the authenticator are mock-only or missing (#257, #252); Safari on iOS, phone dialogs and a phone Lighthouse run are unchecked; the dev seed refuses a remote host without `--allow-host`; `react-router` 6 has two moderate advisories (CI gates at high); production needs `MFA_ENCRYPTION_KEY`, and the migrate step the API's environment.

## Product Scope: End-to-End Patient Journey

The whole hospital workflow, delivered in four releases (R1 pilot OPD, R2 inpatient, R3 specialty and payers, R4 records and operations), each module a feature a hospital can turn on or off. The journeys (OPD, IPD, emergency, surgery, insured patients) and the module map are in `docs/PRODUCT.md`: read them before planning a new module.

### Architecture rules that make the modules fit together

- **Encounter is the spine:** every clinical, ordering and billing record attaches to an `Encounter` (`opd`, `ipd`, `er`, `daycare`) of one patient; no module invents its own visit.
- **Unified orders:** lab, imaging, procedure, medication and diet requests are all `Order` records emitting `order.placed`; consuming modules react to events, never called directly.
- **Charge ledger:** billable work posts charges to the encounter, priced from the price list in effect; invoices are assembled from charges, never written by a module.
- **Master data first,** referenced by id; prices are effective-dated so old bills never change. Large code sets are searched on the server, never bundled.
- **Append-only** stock ledger, medication administration, audit log, results and signed documents: corrections are new entries with reason and author.
- **State machines** (orders, samples, admissions, beds, claims, discharge) enforced on the backend; the UI offers only valid transitions.
- **Concurrency-safe** bookings, beds, theatre slots and stock through database constraints or row locks, never client checks.
- **Every module is a feature module** (flag, permissions, migrations, events, settings) and reaches another one only by events or its `index.ts`.

The full statement of each is in `docs/PRODUCT.md`; `/module-integration-check` checks a module against them.

Out of scope for now: patient portal or app, telemedicine, a DICOM viewer or PACS, full accounting or payroll, and external integrations. Design data models so these can be added later through adapters (`docs/PRODUCT.md`).

## Stack

React 18, TypeScript (strict) and Vite, shipped as a static SPA. Tailwind and shadcn/ui (Radix, one primitive at a time). TanStack React Query for all server state, including the session, tenant config and `AccessPolicy` (`GET /session`). Redux Toolkit for client and workflow state only (multi-step flows, order drafts in memory, UI preferences). React Router v6 (routes generated from the registry, lazy, no data-router features). React Hook Form and Zod. Native `fetch` behind `shared/api` with the typed client generated from the OpenAPI spec (`openapi-typescript`, `openapi-fetch`). i18next. `Intl` for display with `date-fns` and `date-fns-tz` for arithmetic. `lucide-react` icons. TanStack Table and Virtual, Recharts (ECharts lazy for dense analytics), react-big-calendar (MIT, no paid plugin), TipTap, `motion`. Official PDFs and Excel files are made on the server; react-pdf and SheetJS only for previews and import mapping. Vitest, React Testing Library, MSW and Playwright. web-vitals and Sentry (errors only) loaded after first paint. Why each was chosen: `docs/ARCHITECTURE.md`.

## Technology Decisions and Cost Strategy

Proven open-source tools, one per layer, small fixed cost growing with usage, and scaling by configuration, not rewrites (stateless services, `tenant_id` everywhere, cursor pagination, idempotency). Modular monolith on Fastify, PostgreSQL with shared schema and RLS in an India region, pg-boss before Redis, Postgres search before OpenSearch, S3-compatible storage, SSE before WebSocket, self-hosted auth. The principles, the full table of choices, the growth phases and the cost guardrails (no Kubernetes, microservices, Kafka or per-seat SaaS until justified) are in `docs/ARCHITECTURE.md`. Read it before any infrastructure, deployment or new-service work.

### Production baseline (non-negotiable even when cheap)

- Encryption in transit and at rest, automated backups with point-in-time recovery, tested restores, and defined recovery targets.
- Immutable audit log of PHI access and changes, per tenant.
- Compliance: India DPDP Act by default; HIPAA/GDPR controls if serving those markets (signed BAA with hosting provider for US customers).
- Separate dev, staging, and production. **No real patient data outside production.**

### Frontend implications

- **One build for all hospitals.** No per-tenant builds, deploys or branches. Differences are runtime config (tenant config, `AccessPolicy`, feature flags).
- All API calls go through the generated client. List endpoints return a cursor envelope: `{ items, nextCursor, total? }`.
- Only the static SPA is CDN-cached. Tenant config, `AccessPolicy` and all PHI responses are loaded after login, are private per session, and are never CDN-cached.
- Environment config via `VITE_` variables (non-secret): API base URL, Sentry DSN.

## Performance Strategy

Capability first, protected by code splitting, budgets, virtualization, caching and measurement. **Budgets (gzipped, enforced in CI by `scripts/bundle-budget.mjs`):** initial JS <= 300 KB, any route chunk <= 150 KB, heavy lazy chunks (calendar, charts, editor, PDF preview) <= 250 KB each and never in the initial load, total CSS <= 60 KB; a PR that adds more than 30 KB to any chunk says why. Every list is paginated on the server (cursor, 25 to 100 rows); never load a full dataset into the browser. The device targets, Lighthouse and memory targets, build rules, runtime and network rules, backend sizing and the resilience rules (retry, `Retry-After`, abort on navigation, error boundaries per route and widget, idempotency keys) are in `docs/PERFORMANCE.md`. Read it before work on the build, the API client, caching, large lists, live data or load tests.

### Dependency policy

- No banned list: the best well-maintained library for the job, or a platform feature (`fetch`, `Intl`, `URL`, `AbortController`, `structuredClone`, `BroadcastChannel`, `<dialog>`, CSS) when it is as good.
- One library per job (never two table, chart, form, date or component libraries); one design system (Tailwind and shadcn/ui; another suite such as MUI needs a clear reason). Heavy libraries are lazy-loaded. The PR states the reason and the size from `pnpm analyze`.
- Licence MIT, Apache or BSD; no paid or premium plugin and no AGPL in the shipped client without approval. Active maintenance and a clean `pnpm audit`; no deprecated packages such as Moment.
- Official documents and exports are made on the server (workers); printing uses print CSS; downloads use signed URLs. CSS for simple transitions, `motion` for complex ones.

## Responsive Design

Most of the app must work on a phone and a tablet as well as on a desktop: ward rounds, the bedside, a doctor's own device. A screen is built for all three unless it is on the desktop-only list below. Retrofitting a dense screen later costs far more than building it this way.

### Supported widths

- **Phone** 360 to 767 px (360 is the minimum): one column, navigation in the drawer, lists as cards.
- **Tablet** 768 to 1023 px (upright tablet, small laptop window): navigation in the drawer, content as on a desktop, narrower.
- **Desktop** 1024 px and up (hospital PCs, laptops, a tablet on its side): sidebar and the full layout.

These are Tailwind's default breakpoints (`md` 768, `lg` 1024); a data grid changes from cards to a table when its own container reaches 640 px (`sm`), which for a full-width grid is a little above that in screen width. Write styles phone first and add `md:` and `lg:` for more room. Do not add custom breakpoints.

### Rules

- **Nothing makes the page scroll sideways** at any supported width. A wide table may scroll inside its own box; the page may not.
- **Lists use `DataGrid`,** which shows cards when its container is narrower than 640 px and a table otherwise. A screen does nothing to get this. Put the column that names the row first: it becomes the card's title.
- **Touch-sized controls where the pointer is a finger:** at least 44 by 44 px, through Tailwind's `pointer-coarse:` variant, whatever the width (a touch laptop counts, a phone with a mouse does not). `Button`, the form kit, the rich text toolbar and `DataGrid` already do this. A control built by hand adds `pointer-coarse:h-11`.
- **No action that needs hover.** Anything shown on hover is also reachable by focus and by tap, and nothing is hover-only. Tooltips add to a label, they never replace one.
- **Layout follows the space, not the device:** use the width (`md:`, `lg:`, or a container's own width) for layout and `pointer-coarse:` for target size. Never read the user agent.
- **Forms are one column on a phone,** with labels above fields and the right keyboard (`type`, `inputMode`, `autoComplete`).
- **Text stays readable without zooming:** body text at 14 px or more, and inputs at 16 px on a phone so the browser does not zoom on focus.
- **The performance budgets apply at every width.** A phone gets the same bundle, so the budgets in Performance Strategy are also the phone's.

### Desktop-only screens

These may be built for 1024 px and up, wrapped in `DesktopOnly` (`shared/ui/desktop-only`), which below that width shows "This screen needs a wider display" inside the shell and does not mount the screen, so it asks the server for nothing. Accepted with it: a zoomed hospital PC gets the notice (it says to lower the zoom), and narrowing the window across the line loses a half-filled form. Adding a screen to this list is a decision recorded here, not a shortcut taken in a PR.

- Master data catalogs and the bulk import centre.
- Reports and analytics dashboards (their exports still work from any device).
- Platform admin, and the role and permission matrix.
- Week and resource views of the appointment, roster and theatre calendars. The day and agenda views work on a phone.

Billing (invoice assembly, claims) must work on a tablet and a desktop. A phone is not required for it.

### How it is checked

Playwright runs every spec at desktop, tablet (768 px, touch) and phone (360 px, touch); a new screen is added to `e2e/responsive.spec.ts`, and specs reach the navigation through `goTo(page, name)`. "Works at phone and tablet width" is in the definition of done of every frontend issue. The detail is in `apps/web/e2e/CLAUDE.md`.

**Dialogs** should fill the screen on a phone; there is no shared dialog yet. Safari on iOS and a phone Lighthouse run are not checked yet (`docs/STATUS.md`).

## Accessibility

The target is **WCAG 2.2 AA** (decided 2026-10-14, #337), for every screen at every width. Screens are built accessible, not fixed at the end: the hardening audit (H-02, #139) confirms, it does not catch up.

### What 2.2 AA asks of a busy hospital screen

- **Focus is never hidden.** A focused control is not covered by a sticky header, a toolbar or a drawer; give a scroll container `scroll-padding` when it has a sticky part.
- **Targets are at least 24 by 24 px** with a pointer (44 by 44 px under `pointer-coarse:`, see Responsive Design).
- **No action needs dragging.** Anything that can be dragged (an appointment on the calendar, a row reordered) can also be done with a click or the keyboard.
- **Nothing already given is asked again** in the same flow: carry it forward or offer it to pick.
- **Status and errors are announced**, not only shown: a live region for a saved, a refused or a busy state, and the form kit's messages linked to their fields.
- **Zoom, reflow and motion.** Every route reflows at 320 px wide (400% zoom) and takes text at 200% with nothing scrolling sideways, checked for every registered route in `e2e/a11y.spec.ts`. Sizes are in rem so text zoom reaches them. A sticky part of a scroll box gives the box `scroll-padding` of its height, so focus never lands under it (WCAG 2.4.11). Reduced motion is honoured everywhere by one rule in `index.css`: animations and transitions become instant (#344).

### Patterns to use

- **Radix primitives** (through shadcn/ui) for every menu, popover, dialog, tabs, select and tooltip: they bring focus handling, roles and keyboard support. Do not build one of these by hand.
- **The form kit** (`shared/ui/form`) for every form: labels, descriptions and errors are linked to the field, and the first invalid field gets focus on submit.
- **`DataGrid`** for every list: headers, sorting and row actions are reachable and named, in the table and in the cards.
- Semantic HTML first (`button` for actions, `a` for navigation, headings in order, one `h1` per screen), an accessible name for every icon-only control, and colour never the only signal (a status also has a word or an icon).
- **Never leave focus on the page body.** When what had focus goes away (a form that closes, a row that leaves the list, a button that hides itself), move focus on deliberately, to the next control or a focusable status line, through `focusIfLost` (`shared/lib/focus`) or the hooks `useInPlaceFormFocus` and `usePanelFocus` (`shared/hooks/CLAUDE.md` says which shape each fits). A status message goes into a region that is always on the page. A busy or not-applicable control takes `aria-disabled`, never `disabled` (Chromium drops focus from a disabled control); `Button`, `SubmitButton` and `DataGrid` actions do this by themselves. Keep `disabled` for a field that must not change (a fieldset while it saves) and a control that cannot be used at all here.
- The shell already gives a skip link, moves focus to `<main>` on navigation and checks the contrast of a hospital's colours (`shared/lib/theme.ts`). Keep them working.

### Checks every screen gets

axe in the unit test (`expectNoAxeViolations` from `src/test/axe.ts`), axe in Playwright with contrast on (`e2e/a11y.spec.ts` checks every registered route by itself), a keyboard test in Playwright of the screen's main task with focus visible at each step, and `eslint-plugin-jsx-a11y` in lint. "Keyboard and axe checked for changed screens" is in the PR template and the definition of done. The detail is in `apps/web/e2e/CLAUDE.md`.

## Repository Layout

`apps/web` (the SPA), `apps/api` (the API), `packages/contract` (the OpenAPI spec and generated types), `scripts/github/` (roadmap seeding and status), `docs/`, `.claude/`, `.github/`.

- One repo and one issue tracker. API and UI changes for a feature land in the same PR.
- Per-app scripts with `pnpm --filter web|api <script>`; root scripts (`lint`, `typecheck`, `test`, `build`) run across all packages.
- `apps/web` imports only types from `packages/contract`, never code from `apps/api`, and `apps/api` never imports from `apps/web`.
- **Contract flow** (`pnpm gen:api`): the API writes `packages/contract/api.openapi.json` from its route schemas, merged with the hand-written `planned.openapi.json` (endpoints the web app is built against before the API has them) into `openapi.json`, from which the web client types are generated. The API wins: when it implements a planned endpoint, delete it from the planned file (the merge fails until you do). CI fails on stale committed files, or a breaking change without a raised `CONTRACT_VERSION`.

## Backend (apps/api)

- **Fastify + TypeScript** (`tsx watch` in dev, no build step; `tsc` for production). **TypeBox** route schemas give validation, types and OpenAPI from one definition; every route declares request and response schemas and its permissions.
- **Drizzle ORM** with plain SQL migrations, one new file each (`apps/api/src/migrations/NNNN_what.sql`), applied in order by the API's own runner, which refuses to go on if an applied file was edited. No `drizzle-kit`. RLS policies, the `tenant_id` convention and exclusion constraints are SQL in migrations, and migrations are additive. Rules: `apps/api/CLAUDE.md`.
- **Postgres is the only required service in phase 1:** sessions, job queue (**pg-boss**), the transactional outbox and in-process rate limits all live in or beside it. Keep cache, queue and rate limiting behind interfaces so Redis (BullMQ) can replace them in phase 2.
- **Logging:** pino with a redaction config for PHI fields. Never log request or response bodies for patient routes.
- **Security:** cookies, Argon2id (`@node-rs/argon2`), TOTP (`otplib`), a per-address rate limit on the auth routes and a cross-site check on every non-GET request are in place; `@fastify/helmet`, strict CORS and per-tenant and per-user limits are the target (the web app reaches the API through the same origin today).
- **Tests:** Vitest against a local Postgres database. Cross-tenant RLS tests are mandatory for every tenant table.

### Core hooks

Every feature is one encapsulated Fastify plugin (layout in `apps/api/CLAUDE.md`), so its decorators and hooks never leak; adding one is a folder and one line in `app.ts`. Every feature route passes through:

- **`session` hook:** authenticates the cookie session and binds the active tenant.
- **`tenant` hook:** opens a transaction per request and runs `SET LOCAL app.tenant_id = <session tenant>`. RLS then filters every query. The tenant is never taken from a client value.
- **`access` hook:** checks the tenant feature flag and the caller's permissions declared on the route, and gives the handler the caller's scope. A tenant route that declares no `permissions` stops the app from starting.
- **`audit` hook:** records PHI reads and writes in the same transaction.
- **`outbox`:** domain events are written in the same transaction and dispatched by pg-boss.

## Package Manager

**pnpm only.** Never `npm`, `yarn`, `bun` or `npx` (use `pnpm dlx`), and never a `package-lock.json` or `yarn.lock`. CI installs with `pnpm install --frozen-lockfile`; commit `pnpm-lock.yaml`. pnpm's version is pinned in `package.json` (`packageManager`, enabled with `corepack enable`) and Node's in `.nvmrc`/`engines`. The repo is a pnpm workspace (`apps/*`, `packages/*`): per-app work is `pnpm --filter <app> <script>`.

- Keep pnpm's strictness: no hoisting everything or `shamefully-hoist` to silence a missing dependency; declare it. Dependency install scripts stay blocked unless approved in the pnpm config with a stated reason.
- **Native Windows** (PowerShell/Windows Terminal; WSL2 not required). Keep the repo and pnpm store on one drive, in a short path outside OneDrive or any synced folder.
- **Scripts are cross-platform:** no bash-only syntax in `package.json` scripts (`rm -rf`, `export VAR=`, chained shell tricks); use Node scripts, `cross-env`, `rimraf`, `cpy-cli` or `tsx`. LF line endings everywhere (`.gitattributes`: `* text=auto eol=lf`).
- **Dev machine (i3-1115G4, 2 cores, 16 GB):** one editor, Vitest with at most 2 workers, only Chromium for local Playwright (`pnpm --filter web exec playwright install chromium`), Postgres native or Docker capped at 4 GB. Heavy jobs (cross-browser e2e, load tests, production builds) run in CI. Docker Compose (Postgres and Mailpit; MinIO and Redis in the `full` profile) uses named volumes, not Windows bind mounts.

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
pnpm e2e        # Playwright end-to-end tests, at desktop, tablet and phone width
pnpm gen:api    # regenerate typed API client from OpenAPI spec
pnpm test:scripts   # tests of the repo scripts (contract check, bundle budget, CI mode)
pnpm format:check   # Prettier, as CI runs it (pnpm format to fix)

docker compose up -d              # Postgres and Mailpit for the API
pnpm --filter api db:migrate      # apply migrations, then default role permissions
pnpm --filter api db:seed         # sample hospitals and staff (never in production)
pnpm --filter api codes:load --system=icd10 --file=<path>   # load a code set from a code,title file (--dry-run to try it)
pnpm --filter api dev             # the API on http://localhost:3000
pnpm --filter api test            # API tests against the mediflow_test database
```

**Signing in locally.** Against the mock (the default) the app starts signed in as the sample hospital admin; `/?mockUser=none` starts signed out (sample emails and the password are in `apps/web/src/mocks/db.ts`). Against the real API: start it (the commands above) and the web app with `VITE_API_MOCKING=disabled`; Vite proxies `/api` to `http://localhost:3000` (`API_PROXY_TARGET` to change it), one origin as in production.

## Folder Structure (apps/web, feature-based)

`apps/web/src/`: `app/` (providers, shell, i18n, store, observability, error boundary; `app/session/` the session query, sign-in and out, idle timeout, cross-tab channel), `tenancy/` (active tenant, picker, switcher, deep links, theming, formatters), `access/` (`AccessPolicyProvider`, `usePermission`, `<Can>`, `PermissionGuard`), `registry/` (manifests to routes and navigation), `features/<name>/` (one per feature; `clinical`, `billing`, `dashboard` and `platform` planned), `shared/` (`api/` fetch wrapper, typed client and query keys; `config/` env; `lib/` theme, logger, class names; `ui/` the building blocks and system pages; `hooks/`; `types/`; `utils/` tenant-aware formatters and masking), `routes/` (generation and the session and tenant guards), `mocks/` (MSW: `db.ts`, handlers) and `test/` (render helpers, setup).

The generated API types live in `packages/contract/src/generated`, not under `shared/api`.

Each feature folder contains: `manifest.ts` (see Extensibility), `components/`, `hooks/` (React Query hooks), `api.ts`, `schemas.ts` (Zod), `types.ts`, `index.ts` (public exports), and a `CLAUDE.md` with what was decided for the module (see Current Status). Features must not import from each other's internals, only via `index.ts` or `shared/`.

Path alias: `@/` maps to `apps/web/src/`.

## Multi-Tenancy (multiple hospitals)

Each hospital is a tenant; a user belongs to one or more, with a role per tenant. **One shared URL** for all hospitals: no per-hospital subdomains, paths or builds, and the tenant comes from the session, never from the URL.

- One generic, unbranded login page. After login `GET /session` returns the user, memberships, the **active tenant**, tenant config and `AccessPolicy`; nothing renders until it resolves.
- One hospital goes straight in; several get a picker, and a switcher in the header later (`POST /session/switch-tenant` rebinds the session and returns the new config and policy).
- A patient record belongs to exactly one hospital.
- **Deep links** use one address, `/open/<kind>/<id>`, with globally unique ids: the app sends them to `POST /session/open-link`, the server finds the owning tenant, checks membership and switches if needed, and the record's own route guard still applies. No membership and no record give one answer and one "This link is not available" page. A feature makes a kind linkable with `links: [{ kind, to }]` in its manifest. Never put a tenant, a hospital name or anything about the record in a link.

**Tenant config** comes with the session, never hardcoded: branding, locale and language, timezone, currency, date format, the feature flags, auth settings (password or SSO), and later custom fields.

**Rules:**

- The **active tenant lives in the server-side session**; the backend never trusts a client value. The client may send `X-Tenant-ID` as a consistency check, refused when it does not match (a stale tab after a switch): reload the session and show a notice, since a switch in one tab affects all tabs.
- **Every React Query key includes `tenantId`**, through key factories only (see Conventions).
- On tenant switch or logout: clear the React Query cache, reset any global stores, abort in-flight requests.
- No hardcoded hospital names, currencies, date formats, timezones or locales: tenant-aware formatters from `shared/utils`. Gate modules by tenant feature flags in routes and navigation. MRNs are unique per tenant. Test every feature with at least two tenants.

## Extensibility and Access Control

Goal: add a feature later by adding a folder, and turn any feature or action on/off per hospital and per role through configuration, not code changes.

### Feature modules (plug-in architecture)

Each feature declares itself in `manifest.ts` (routes with `requires`, nav, permissions, feature flag, slot contributions, settings, i18n, links). The registry drops manifests whose flag is off and generates the routes, navigation and widgets: no hand-edited route or menu lists. Adding a feature is a new folder, a manifest and one line in `registry/features.ts`, with no edit to core, routing or another feature. Route and slot modules default-export their component; every route has its own static page title; features talk only through `index.ts`, shared types or slots. The manifest shape, the slots, the domain events, per-hospital settings and the checklist are in `docs/EXTENDING.md`: read it before adding a module, a slot, a slot contribution or an event.

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

The default matrix of what each role gets is seed data, in `docs/PRODUCT.md`.

Platform admins manage tenants and get **no default access to patient data**; any support access is explicit, audited and time-limited.

Scope rules such as "own patients only" or "own schedule" (for doctors) are data-scope constraints evaluated by the backend and surfaced to the UI as part of the policy (e.g. `scope: 'own'`). Do not reimplement them on the client.

### Adding a new feature later

**Rules**

- Dependency direction is one-way: feature modules depend on `shared/` and core public APIs. Core never imports a feature.
- A feature adds itself through five hooks only: a **manifest** (routes, nav, permissions, flag), **extension slots** (UI contributions to existing screens), **domain events** (reacting to what core does), its **own tables** (additive migrations), and **per-hospital settings**.
- Core changes allowed for a new feature are strictly additive: nullable columns, new events, new slots. Never change the meaning of existing fields.
- Every feature ships dark behind a feature flag, off by default, enabled per hospital by `platform_admin`, with its permissions registered and default role grants seeded.

Core screens render slots (`patient.detail.tabs`, `patient.detail.actions`, `patient.form.fields`, `appointment.form.fields`, `appointment.row.badges`, `appointment.row.actions`, `appointment.detail.actions`, `queue.row.actions`, `dashboard.widgets`, `settings.sections`, `nav.items`); add one only when a real feature needs it. Events go through the transactional outbox, carry `tenantId`, entity id, actor and timestamp, and handlers are idempotent; subscribers live in their own module and never modify the emitter. The slot rules, the event list and the worked example of appointment reminders are in `docs/EXTENDING.md`.

### Hospital onboarding (platform_admin)

The platform admin role, onboarding hospitals and its rules (seeded first admin, MFA, no patient data, time-limited audited support access, every platform action audited) are in `docs/ARCHITECTURE.md`. Read it before working on the platform module.

## Domain Types

Types that exist are in code, not here: `apps/web/src/shared/types/index.ts` (roles, permissions, `AccessPolicy`, `Tenant`, `User`), `apps/web/src/registry/types.ts` (`FeatureManifest`, slots) and each feature's `types.ts`, taken from the contract.

What they hold to: roles are data, not a closed union, because hospitals create custom roles; a permission is `resource:action` with an optional scope (`all`, `own` or `department`); every tenant-owned entity carries `tenantId`; an MRN is unique per tenant; a slot contribution is given ids and values, never a whole record; and `contactConsent` is captured at registration for future messaging features.

The shapes still to build (`Appointment`, `Encounter`, `Order`, `Charge`, `Invoice`) and the list of the other entities by module are in `docs/PRODUCT.md`.

## Build Order

The detailed plan is `docs/ROADMAP.md` (generated from `scripts/github/roadmap.mjs`), in milestones and the four releases (`docs/PRODUCT.md`). R1 runs Setup, Foundation, Auth, Patients, Doctors and staff, Master data, Appointments, queue and triage, OPD clinical and orders, Laboratory, Radiology, Pharmacy and inventory, Billing, Reports, Platform admin, Roles, Hardening and pilot launch.

Complete and test one module before starting the next. Ship each release to a pilot hospital before starting the next, and run the hardening checklist at the end of every release. Build master data and the encounter, order and charge foundations before any module that depends on them.

## Conventions

- **State:** server data (session, tenant config and policy included) lives in React Query, never copied into Redux. Redux Toolkit holds client and workflow state only, and every slice resets on tenant switch and logout. Local component state for everything else.
- **Query keys:** from each feature's key factory, always prefixed with the tenant (`patientKeys.list(tenantId, filters)`); invalidate precisely after mutations.
- **Shared building blocks** (`apps/web/src/shared/ui`, with working examples at `/examples` in dev): build lists with `DataGrid` (every tabular list; server-side sorting and cursor paging, masked columns, `requires` on columns and actions, pass `total` when the server gives one), charts with `TimeSeriesChart` and `CategoryBarChart`, forms with the form kit (`useZodForm`, `Form`, the fields, `SubmitButton`), notes with `RichTextEditor` and `RichTextView` (a sanitized JSON document, never HTML) and calendars with `Calendar` (UTC instants drawn on the hospital's clock). Never import the underlying libraries in feature code. What each one does and takes is in `apps/web/src/shared/ui/CLAUDE.md`: read it before using one in a new way.
- **Forms:** React Hook Form and a Zod schema through the form kit, types from `z.infer`, labels and messages through i18n. A free-text field that is stored and printed (a name, a unit, a note) adds `.regex(PLAIN_TEXT, 'validation.plain_text')` from `shared/utils/text` (`PLAIN_LINES` for several lines), the patterns the API refuses on; a search term is never refused.
- **Searches:** a search whose term can say something about a patient (patients, codes, drugs, lab tests, services, and any new catalog searched while recording care) goes in the body of a `POST …/search`, never in a query string, because a term beside a patient id in a CDN, load balancer or firewall log is patient data the API's redaction never sees. It reads only, its body is not logged, and it answers a cursor page. A list nobody types patient facts into (departments, staff, wards) stays a `GET` (#289).
- **Typing:** no `any`. Prefer `unknown` + narrowing. API responses are validated or typed at the `api.ts` boundary.
- **Components:** small, single-purpose function components with named exports, `PascalCase`; functions and variables `camelCase`; styles and tests co-located.
- **Async UI:** every data view handles loading, empty, and error states.
- **Editing a record two people can change:** send only the changed fields with the `version` the edit started from, working from a snapshot taken when the form opened. On a conflict keep what the person typed in their changed fields, take what was saved in the others, and show the saved value under a field both changed. Short form for a plain record: `features/drugs/routes/DrugDetail.tsx` (dirty fields, `reset(latest, { keepDirtyValues: true })`, Save never left waiting). Full pattern: `features/patients` (`use-update-patient.ts`, `PatientEdit.tsx`): optimistic save, the unsaved edit held in the query cache under the hospital's key (memory only), nothing written once the session ended.
- **Dates and money:** ISO strings (UTC) and minor units in storage and transit; format only for display with the tenant's locale, timezone and currency. A calendar date that is not an instant (a date of birth, the day a price starts) uses `format.calendarDate`; `format.date` is for instants. A typed amount becomes minor units on its digits, never through a float, and a comma only where grouping puts one (`toMinor` in `features/services/schemas.ts`): "12,50" is refused.
- **i18n:** no user-facing string literals; translation keys only. Core strings in `app/locales/<language>/common.json`; a feature keeps its own in its folder, declared in `manifest.i18n`. The language follows the hospital's locale (`hi-IN` uses `hi`) and falls back to English per key. Tests fail on a rendered key with no translation.
- **Errors:** centralize API error handling in the API client wrapper. Surface user-friendly messages, never raw server errors.

## Security and Privacy (healthcare data)

- Treat all patient data as sensitive PHI.
- **Tenant isolation is a security boundary:** never derive authorization from a client-supplied tenant value.
- Never log PHI to the console, error trackers or analytics.
- **Error reporting and logging** (web: `app/observability/`, `shared/lib/logger.ts`): errors only, no replay, tracing or breadcrumbs; every event is rebuilt from an allowlist (`scrubEvent`) and error messages are never sent, so put a stable code, not data, in an error. Report a caught error with `reportError(error)` and no context object. App code never calls `console.*`: use `logger.warn` or `logger.error` with a static event name and fields from the `LogFields` allowlist, where a new field is a reviewed change. The whole policy is in `apps/web/src/app/observability/CLAUDE.md`.
- No PHI in `localStorage`, `sessionStorage` or any persistent browser storage, a service worker or a CDN: keep it in memory. Tokens live in httpOnly cookies.
- **Every way a session ends** (sign-out, idle, another tab, a 401) goes through `endSessionLocally` in `app/session/`, which drops all cached data and client state before the login page shows. Idle time comes from the tenant config, a dialog warns in the last minute, and tabs share activity over a `BroadcastChannel` carrying fixed words only. The detail is in `apps/web/src/app/session/CLAUDE.md`.
- Mask sensitive fields where the full value is not needed (phone, MRN in lists). Audit-relevant actions (reading or editing a patient record, billing changes) go through the API, which logs them per tenant.
- Never hardcode secrets. Use `.env` (git-ignored) with `VITE_` prefix only for non-secret config.
- Sanitize anything rendered from user input; no `dangerouslySetInnerHTML`. A strict Content-Security-Policy and standard security headers at the CDN/host.

## Testing

- Vitest and React Testing Library for forms, guards and hooks; the network is mocked with MSW, never by mocking fetch. Each feature tests the happy path, validation errors and permission-based visibility.
- **Responsive and accessibility tests:** see How it is checked (Responsive Design) and Checks every screen gets (Accessibility).
- **Multi-tenant tests:** verify cache isolation when switching tenants, tenant-scoped query keys, tenant-specific theming/locale/feature flags, and that disabled modules are unreachable.
- **Access tests:** for each feature, test with permission present, permission absent, feature flag off, and a custom role. Verify hidden nav/routes/actions and 403 handling. Verify policy refresh updates the UI without reload.
- **Performance tests:** Lighthouse CI and bundle budgets in CI; large result sets (10k+ rows) keep the page responsive and memory flat; k6 load tests run against staging from a cloud runner, per tenant and with mixed tenants.
- **Foundation coverage is enforced.** CI runs `pnpm test:coverage`, which fails if line, branch, function or statement coverage of `access/`, `tenancy/`, `registry/`, `shared/api/` and `app/session/` drops below the thresholds in `apps/web/vitest.config.ts`. A change to those folders ships with its tests. Lower a threshold only with a stated reason.
- A task is done when CI is green: it runs the full `pnpm lint`, `pnpm typecheck`, tests, build and end-to-end suites. Locally, run `pnpm typecheck` and the tests for the code you changed before opening the PR, and leave the full suite to CI (the dev machine is slow). A PR that changes only Markdown runs the format check alone, and a merge whose content the PR run already tested is not tested again on `main` (`scripts/ci-mode.mjs`).

## Workflow (GitHub issues)

Issues are the source of truth for scope and progress. The roadmap is defined in `scripts/github/roadmap.mjs` (see `docs/ROADMAP.md` and `docs/WORKFLOW.md`).

- **One issue at a time.** Titles start with an ID (`[F-03] Session bootstrap`). Read it with `gh issue view <n>` (tasks, acceptance criteria, dependencies) and confirm its dependencies are closed. **Plan first** for size M or L and wait for approval.
- **Branches** `feat|fix|chore/<n>-<slug>`; **commits** Conventional Commits with the issue number (`feat(patients): add search (#42)`); **a PR** does one issue and its body ends with `Closes #<n>`, plus a `Closes #<m>` line and a sentence for any other issue it fully resolves. Close an issue by hand only when no PR can (a duplicate, won't do, found resolved after a merge), with a comment naming the PR or the reason.
- **Do not widen scope.** Anything discovered but out of scope becomes a proposed new issue (title, labels, milestone, tasks), not part of the current change.
- Labels: `type:*`, `area:*`, `P0`-`P2`, `size:S|M|L`, `status:in-progress|in-review|blocked|needs-decision`. Never mark an issue `status:blocked` without stating the blocker in a comment.
- Done means the issue's Definition of Done is satisfied, including `/tenant-safety-check` and `/phi-check` where data or access is touched. In `/finish-issue` the `security-reviewer` subagent applies both checklists in one pass over the diff against `main`. Once CI is green, Claude merges the PR and removes `status:in-progress`; `status:in-review` is only for a PR the user asked to review first.
- Backend work (`area:backend`) lives in `apps/api` of this same repo. Frontend issues build against the MSW mock and the OpenAPI contract until the matching backend issue is done. A feature's frontend and backend issues may share one PR when they are small.

## Working Agreement for Claude

- Follow the build order and the Workflow above. Ask before changing the stack or folder structure. Small, reviewable changes; explain non-obvious decisions briefly; reuse shared components and types first.
- A new feature is scaffolded with `/new-feature` (types with `tenantId`, Zod schema, API functions, tenant-scoped hooks, components, manifest, MSW handlers, tests with two tenants and the permission cases), registered in the registry with no edit to core routing or another feature.
- For any clinical or financial module, run `/module-integration-check`: it must use `Encounter`, the unified `Order`, the charge ledger and domain events as described in Product Scope, never its own parallel concepts.
- Before changing a module, read its own notes (see Current Status). When a decision is made for a module, write it in its web feature folder's `CLAUDE.md`, or for its API in `apps/api/src/features/<name>/CLAUDE.md`.
- Before changing a core module for a new requirement, check whether it can be done as a feature module, extension slot, or event subscriber. Core changes must be additive.
- New dependencies are allowed when the work needs one and it meets the Dependency policy: Claude may add it without asking first, and states the reason, the licence and the bundle impact (for the web app) in the PR. Nothing paid: a paid service or dependency needs an explicit justification and a cheaper alternative noted.

## Open Decisions

The questions still open (cloud provider, compliance scope, SSO, ABAC, custom roles, integrations, statutory formats, pilot modules and more) are in `docs/OPEN_DECISIONS.md`. Check it before a choice that one of them could change.
