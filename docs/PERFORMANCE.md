# Performance and scalability

The targets, build rules, runtime rules and resilience rules behind non-negotiables 2 and 5. Moved out of the root `CLAUDE.md` (#370), which keeps the budgets and the dependency policy and points here. Read it before work on the build, the API client, caching, lists over large data, live data or load tests.

## Performance Strategy

Goal: a fast, smooth, reliable application under heavy daily use. Capability comes first: pick the best library for each job and accept bundle weight where it earns its place. Performance is protected by code splitting, budgets, virtualization, caching and measurement, not by avoiding libraries.

### Targets

- **Devices and browsers:** mid-range hospital PCs (i3-class CPU, 8 GB RAM) on evergreen Chrome, Edge and Firefox (last 2 versions) over broadband or hospital LAN, and current phones and tablets (Chrome on Android, Safari on iOS) at the widths in Responsive Design. No IE and no legacy builds. The login page and app shell must also remain usable on a throttled Slow 4G connection.
- **Budgets (gzipped, enforced in CI):** initial JS <= 300 KB, any route chunk <= 150 KB, heavy lazy chunks (calendar, charts, editor, PDF preview) <= 250 KB each and never in the initial load, and total CSS <= 60 KB. A PR that adds more than 30 KB to any chunk must say why.
- **Lighthouse** (desktop preset on mid-range CPU throttling, plus one Slow 4G run for login and the shell) on login, the patient list and the encounter screen: LCP <= 2.5 s, INP <= 200 ms, CLS <= 0.1, TBT <= 300 ms.
- **Memory:** page sizes of 25 to 100 rows (virtualize beyond about 100 rendered rows), React Query `gcTime` of 5 minutes, and a flat JS heap across a 30-minute soak test.
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
