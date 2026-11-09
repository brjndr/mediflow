# Performance and scalability

The targets, build rules, runtime rules and resilience rules behind non-negotiables 2 and 5. Moved out of the root `CLAUDE.md` (#370), which keeps the budgets and the dependency policy and points here. Read it before work on the build, the API client, caching, lists over large data, live data or load tests.

## Performance Strategy

Goal: a fast, smooth, reliable application under heavy daily use. Capability comes first: pick the best library for each job and accept bundle weight where it earns its place. Performance is protected by code splitting, budgets, virtualization, caching and measurement, not by avoiding libraries.

### Targets

- **Devices and browsers:** mid-range hospital PCs (i3-class CPU, 8 GB RAM) on evergreen Chrome, Edge and Firefox (last 2 versions) over broadband or hospital LAN, and current phones and tablets (Chrome on Android, Safari on iOS) at the widths in Responsive Design. No IE and no legacy builds. The login page and app shell must also remain usable on a throttled Slow 4G connection.
- **Budgets (gzipped, enforced in CI):** initial JS <= 300 KB, any route chunk <= 150 KB, heavy lazy chunks (calendar, charts, editor, PDF preview) <= 250 KB each and never in the initial load, and total CSS <= 60 KB. A PR that adds more than 30 KB to any chunk must say why.
- **Lighthouse** (desktop preset on mid-range CPU throttling, plus one Slow 4G run for login and the shell) on login, the patient list and the encounter screen: LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1, TBT <= 300 ms.
  How it runs (#457): `pnpm lighthouse` builds the app with the mock API, serves it on port 4173 and audits the login page, the landing page, patients, appointments, encounters and reports (3 runs each, median), then the login page and the landing page again on Slow 4G. Config: `apps/web/lighthouserc.cjs`, `lighthouserc.slow4g.cjs` and the route list in `lighthouse.shared.cjs`; reports go to `apps/web/.lighthouseci*` (git-ignored) and CI uploads them as `lighthouse-reports-<n>`. In CI the three configs (desktop, Slow 4G, phone) run as three parallel jobs, each with `lhci autorun --config=<file>`; `pnpm lighthouse` runs all three in turn. It needs Chrome (set `CHROME_PATH` to Playwright's Chromium locally); a local run on the dev machine is slow, so try one route with `pnpm --filter web exec lhci autorun --config=lighthouserc.cjs --collect.url=<url> --collect.numberOfRuns=1`. LCP and CLS fail the job at the targets. Because the mock API (MSW) runs in the page and adds about 2 s of scripting, TBT and the request count only warn at the targets and fail at ceilings that catch a regression; INP cannot be measured in a lab run, so TBT stands in. Slow 4G has no number in this document: its limit is LCP 4 s as a target and 7 s as the failure. Tighten the ceilings once CI shows what the runner measures. Add a screen to the main flow by adding its URL to `lighthouse.shared.cjs`.
  Phone run (#138): `lighthouserc.mobile.cjs` audits login, patients and encounters with the mobile form factor (360 px screen, touch, a good 4G connection, CPU slowed 4 times) against the same LCP and CLS targets; its reports are in `apps/web/.lighthouseci/mobile`, inside the folder CI already uploads.
- **Memory:** page sizes of 25 to 100 rows (virtualize beyond about 100 rendered rows), React Query `gcTime` of 5 minutes, and a flat JS heap across a 30-minute soak test. The soak is `pnpm --filter web soak [minutes] [url]` (`apps/web/scripts/soak.mjs`) against the preview build: it moves between six routes, forces a garbage collection before each heap reading and fails when the last quarter's median heap is more than 20% above the first quarter's. It is run by hand before a release, not in CI. The grid keeps a 10,000-row list to a screenful of rows in the DOM (`DataGrid.test.tsx`, virtualisation).

### Audit status (H-01, #138)

Checked in CI on every PR: the bundle budgets (`pnpm budget`), the desktop, Slow 4G and phone Lighthouse runs, virtualisation of 10,000 rows. Left for staging, which does not exist yet (#56): LCP, INP and CLS measured against the real API on the deployed build (web-vitals reports by tenant and route), a Lighthouse run without the mock's scripting cost (then tighten the TBT and request-count ceilings), and the first 30-minute soak recorded here with its figures.

- **Requests:** at most 20 requests on first load. The session bootstraps in one request, and there are no request waterfalls before first render.

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
- HTTP caching: ETag and 304 for the session policy, revalidated by the app itself (it keeps the policy and the ETag in memory); every API answer is `private, no-store`, so no browser keeps a copy. Debounce, cancel and dedupe requests. Prefetch the next page and likely routes only on hover or when idle.
- Avoid re-render storms: colocate state, split contexts (session, tenant, policy), and memoize only after profiling.
- Images are SVG or WebP, lazy-loaded, and logos are capped at 50 KB.

### Backend and infrastructure

- Fastify. Containers use multi-stage builds, slim base images and ARM where available, with memory limits tuned from measurements (start at 512 MB per instance and raise it when metrics call for it).
- Phase 1 starts with few moving parts: one API container, Postgres, object storage and the CDN. Jobs run on a Postgres-backed queue and rate limits and cache are in-process. Introduce Redis (shared cache, rate limits, SSE fan-out across instances, BullMQ) as soon as profiling or a second API instance shows a benefit, which can be well before phase 2. Keep queue, cache and rate limiting behind interfaces so the swap is configuration.
- One database, one deployable and one region until metrics require more.
- Local Docker Compose uses profiles: the default profile runs only Postgres and Mailpit. `--profile full` adds MinIO (and Redis once it is needed). This keeps laptop RAM free.

## Scalability

The bundle budgets, code splitting, pagination, virtualization, rendering and asset rules are in Performance Strategy, and the shape of the platform is in Technology Decisions. This section adds what they do not say.

### Frontend performance

- **Search inputs:** debounce them (300 ms) and cancel stale requests. No fetch-all-then-filter-client-side.
- **React Query tuning:** set sensible `staleTime` per data type (reference data like departments: minutes; live data like appointment slots: seconds). Use `placeholderData`/`keepPreviousData` for pagination, prefetch likely next views, and rely on request dedupe. Use optimistic updates where safe.
- **Live data:** no polling loops without backoff. Prefer SSE/WebSocket only for truly live views (queues, bed status), and keep them scoped to a tenant channel. Phase 1 passes changes between instances with Postgres `LISTEN`/`NOTIFY` (`core/live`); Postgres serialises the commits of transactions that notify and refuses a notification when its queue is full, so commit latency of queue writes under load is the signal to move the bus to Redis pub/sub.
- **Do not cache PHI** in service workers, CDN, or persistent browser storage.

### Resilience under load

- API client: timeouts, retry with exponential backoff + jitter for idempotent requests only, and respect `Retry-After` on **429**. Show a friendly "busy, retrying" state.
- Cancel in-flight requests on navigation/unmount (`AbortController`).
- Error boundaries per route and per widget so one failure doesn't blank the app.
- Graceful degradation: if a non-critical widget fails (e.g. dashboard chart), the rest of the page still works.
- Idempotency keys on create/payment mutations to prevent duplicates on retry or double-click.
- Mark submit buttons unavailable while mutations are pending (`SubmitButton` does: `aria-disabled`, which refuses a second press and keeps focus).

### Platform and backend expectations (see Technology Decisions)

- `tenant_id` on every table, enforced with PostgreSQL row-level security; composite indexes starting with `tenant_id`.
- **Per-tenant rate limits and quotas** so one busy hospital cannot degrade others (noisy-neighbor protection).

### Monitoring

- Report Core Web Vitals (LCP, INP, CLS) tagged by tenant and route (no PHI).
- Track API error rate and p95 latency per tenant.
- Lighthouse CI and bundle-size checks on every PR.

## Load testing

k6 scenarios in `loadtests/` (#142). k6 is a single binary, free and open source; locally run it from Docker (`docker run --rm -v <path>/loadtests:/s -e BASE_URL=http://host.docker.internal:3000 grafana/k6 run /s/mixed.js`) or install it. They sign in once per sample account in `setup` (the sign-in route allows 10 attempts a minute per address), then read with the session cookie. Environment: `BASE_URL`, `APP_ORIGIN` (must equal the API's `APP_BASE_URL` for writes), `STAFF_PASSWORD`, `VUS`, `DURATION`, `FLOOD_VUS`, `B_VUS`. The accounts are the ones `db:seed` makes, so run them against a seeded dev or staging database, never against production.

- `loadtests/mixed.js`: staff of two hospitals at a steady pace (a request every 3 to 5 seconds each), a read mix of the patient search (40%), the session (25%), the queue board (20%), the stock list (10%) and an OPD census report (5%).
- `loadtests/noisy-neighbour.js`: hospital A sends requests with no pause while hospital B works normally. Passes when B sees no 429 and the targets below, and A is refused with `Retry-After` and never answered with a 5xx.

### Targets (p95 unless stated, a seeded hospital of 250 patients, one API instance)

| Route                                     | p95       |
| ----------------------------------------- | --------- |
| `POST /patients/search` (also p99 < 800)  | < 300 ms  |
| `GET /session`                            | < 200 ms  |
| `GET /queue/display`                      | < 300 ms  |
| `GET /inventory/stock` (a page of 25)     | < 400 ms  |
| `POST /reports/opd_census` (7 days)       | < 1500 ms |
| Failed or refused requests at normal pace | < 1%      |

These are thresholds in the scripts, so a run exits non-zero when one is missed. They are for staging on the intended instance size; tighten them from the first staging run. Writes (booking, dispensing, invoices) are not in the mix yet.

### First results (2026-11-07)

Dev laptop (2 cores) with k6 in Docker, the API, Postgres and request logging all on the same machine, 60 seconds each, so these show the shape, not capacity:

- Mixed, 8 users: every target met (search p95 95 ms, session 90 ms, queue board 32 ms, stock 68 ms, report 32 ms).
- Noisy neighbour, A with 20 clients: A refused 6,143 times with `Retry-After`, no 5xx, B never refused. B's latency still rose to p95 200 ms (search), 320 ms (queue board) and 257 ms (session) from under 100 ms alone, over the targets for two routes.

### Bottlenecks found

- **A refused request still costs the instance's one event loop.** The per-hospital and per-user limits keep B out of the 429s and the database, but a flood of 150 requests a second still slows B on a shared process. Flood protection belongs also at the edge (load balancer or CDN rate rules) before the instance, and the run must be repeated on staging where k6 does not share the CPU. Proposed as an issue.
- **Limits are per user before they are per hospital.** With `RATE_LIMIT_USER_PER_MINUTE` 240, a flood from a few accounts hits the user limit first, so the hospital limit (1200) is not exercised by these scenarios. A test with many accounts of one hospital needs more seeded users.
- **Per-request logging** (pino at info) is on the hot path in these runs; measure with the production log level.
- Not measured yet: writes, the SSE queue board with many listeners (see Live data), report runs by the worker, and a database of a realistic size (the seed has 250 patients; the search index and the replica need 100,000 or more to say anything).
