# Architecture reference

Reference for infrastructure, the technology choices, the platform admin module and patient messaging. It was moved out of the root `CLAUDE.md`, which holds the rules and points here. Read the section that applies before starting that work.

## Web stack

The root `CLAUDE.md` lists the stack in one paragraph; this is the reason for each choice.

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
- **Scheduling views:** react-big-calendar (MIT) for appointment, roster and theatre calendars, through the shared `Calendar` (#72). No paid plugin or licence during development (see Open Decisions); its free `resources` option draws several doctors or theatres side by side
- **Rich text:** TipTap for clinical notes, templates and discharge summaries (sanitized output, no raw HTML injection)
- **Motion:** `motion` (Framer Motion) for meaningful transitions, kept off critical paths
- **Documents:** official PDFs and Excel exports (invoices, discharge summaries, reports) are generated on the server for consistent output and audit. Client-side libraries (react-pdf, SheetJS) are allowed for previews and import mapping
- Testing: Vitest + React Testing Library + MSW, Playwright for end-to-end
- Observability: web-vitals and Sentry (errors only, no replay or tracing) loaded lazily after first paint, with PHI scrubbing

## Principles

- Prefer boring, proven, open-source tech. One well-chosen tool per layer.
- Start small and cheap, but design so scaling needs **configuration, not rewrites** (stateless services, `tenant_id` everywhere, cursor pagination, idempotency).
- Avoid per-seat or per-event SaaS until revenue justifies it. Avoid lock-in on anything whose bill grows with traffic.
- Do not build later-phase infrastructure until metrics demand it.

## Target architecture

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

## Growth phases

1. **Dev and pilot (0 to a few hospitals):** everything runs locally in Docker; mock API until the backend exists. Deploy one small API container, a small managed Postgres (background jobs run on a Postgres-backed queue such as pg-boss), object storage, and the CDN-hosted SPA. Fixed, predictable monthly cost.
2. **Growth:** run containers on a managed orchestrator (ECS Fargate or Cloud Run) with autoscaling and at least 2 instances across zones; add a Postgres read replica and connection pooling (PgBouncer); add Redis for shared cache, rate limits and queues (BullMQ); separate worker containers for queues; put a WAF and per-tenant rate limits in front.
3. **Large scale:** partition big tables (appointments, invoices) by tenant/time, add more replicas, move the largest hospitals to dedicated databases, add multi-zone failover, and multi-region only if required.

## Cost guardrails

- Budget alerts from day one. Tag resources by environment and, where possible, by tenant. **Meter per-tenant usage** (requests, storage, active users) so hospitals can be priced and cost attributed.
- Autoscale with sensible min/max. Prefer ARM instances. Shut down non-prod outside working hours. Buy reserved capacity or savings plans only after 2 to 3 months of stable usage.
- Push work to the edge: CDN caching for static assets and non-PHI tenant config, cache reference data, compress responses, cap log retention, move old records and files to cheaper storage tiers.
- Self-host OSS (Keycloak, Grafana) only when ops time costs less than the SaaS bill. Otherwise use managed.
- Avoid until justified: Kubernetes, microservices, Kafka, paid UI component suites, per-seat enterprise SaaS.

## Hospital onboarding rules (platform_admin)

`platform_admin` is the built-in role for the product owner/operators and is the only role that can onboard hospitals. It is not scoped to any hospital, uses the `features/platform/` module, and has **no access to patient data** by default.

The onboarding flow (create the hospital, choose its plan and features, seed its roles, invite its first admin, activate) is in `docs/ARCHITECTURE.md`. Read it before working on the platform module.

Rules:

- The first `platform_admin` is created by a seed script or CLI at deploy time, never through the UI or public sign-up. Require MFA for all platform admins.
- Platform admins can create or edit a hospital's config and invite its first admin, but cannot view patient records, appointments, clinical data, or billing.
- Any exceptional support access to a hospital's data must be explicit, time-limited, approved by that hospital's admin, and written to the audit log.
- Every platform action (create, suspend, feature toggle, impersonation if ever allowed) is audit-logged.
- A hospital admin can only manage users and roles within their own hospital.

## Hospital onboarding flow (platform_admin)

All in the platform module, under the rules above.

1. **Create hospital:** name, slug, locale, timezone, currency, branding (logo, primary color), region.
2. **Choose plan/features:** enable or disable modules (feature flags) for this hospital, and set limits (e.g. max users, storage).
3. **Seed roles:** the built-in roles are created for the new hospital with default permissions (editable later by its admin).
4. **Invite first hospital admin:** enter the admin's name and email. The system sends an invite link. The admin sets a password and MFA, then signs in and invites their own staff.
5. **Activate:** the hospital goes live. It can later be suspended (blocks all logins, keeps data) or offboarded (export, then scheduled deletion).

## Worked example: appointment reminders (planned, not in v1)

Nothing in core changes. The feature adds:

- Backend `reminders` module subscribing to `appointment.created|rescheduled|cancelled`. It schedules or cancels delayed jobs, checks `patient.contactConsent`, renders a hospital-specific template, and sends through the `Notifier` interface using email/SMS/WhatsApp providers. It meters messages per hospital against a quota and honors opt-outs.
- Frontend `features/reminders/`: a settings section (channels, timing, templates, quota), an `appointment.row.badges` contribution ("reminder sent/failed"), and a `reminder:manage` permission.
- Messages contain minimum necessary information (date, time, hospital name) and never diagnoses or department names that reveal a condition.
- What v1 must already provide for this: the appointment events, the `Notifier` abstraction, patient phone/email/`contactConsent` captured at registration, the slot and settings mechanisms, and feature flags with per-tenant settings.
