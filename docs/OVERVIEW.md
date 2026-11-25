# Architecture overview

A one-page picture of how the system fits together, for a new engineer or an operator. It summarises; the reasons for each choice are in [`ARCHITECTURE.md`](ARCHITECTURE.md), the rules in the root `CLAUDE.md`, and the journeys and module map in [`PRODUCT.md`](PRODUCT.md). What is built is in [`STATUS.md`](STATUS.md).

## The system in one picture

```
 Browser (staff only)         CDN              API (stateless, Fastify)                Postgres
 React SPA, one build  --->  static files
        |
        +-- /api (same origin, httpOnly cookie) -->  session -> tenant -> access ->  one shared schema,
                                                     audit -> handler -> outbox ---> tenant_id + RLS,
                                                        |      |                     sessions, jobs, outbox
                                                        |      +-- jobs (pg-boss)
                                                        +-- live (LISTEN/NOTIFY, server-sent events)
                                                        +-- files (FileStore: local folder, S3 adapter)
                                                        +-- Notifier (staff email, SMTP)
```

- **One deployment for every hospital.** One SPA build, one API image, one database. A hospital is a tenant; differences are runtime config (branding, flags, policy), never a separate build or branch.
- **Staff only.** Patients are records, not users. Nothing contacts a patient in v1.
- **Postgres is the only required service** in phase 1: sessions, the job queue, the outbox and rate limits live in or beside it, behind interfaces so Redis can replace them later.

## Request path

Every feature route runs the same hooks, in order (`apps/api/src/core/`):

1. **session:** authenticates the cookie and binds the active tenant from the server-side session. A client-sent tenant (`X-Tenant-ID`) is only a consistency check.
2. **tenant:** opens one transaction per request and runs `SET LOCAL app.tenant_id`. Row-level security then filters every query, so a missing `WHERE` cannot leak another hospital's rows.
3. **access:** the hospital's feature flag is on **and** the caller's role holds the route's declared permission. A tenant route with no `permissions` stops the app from starting. Scope (`own`, `department`) is evaluated here, never in the client.
4. **audit:** PHI reads and writes are logged in the same transaction. A refusal is logged as `denied.<action>`.
5. **handler:** SQL on `request.txClient`; domain events are written with `request.emit` in the same transaction (the outbox).

After commit, the outbox dispatcher hands events to subscribers through pg-boss. Handlers are idempotent and live in their own module.

## Data and tenancy

- Every tenant table carries `tenant_id` with an RLS policy, and `core/db/rls-coverage.test.ts` fails when one does not. Cross-tenant tests are mandatory for each table.
- Migrations are numbered plain SQL (`apps/api/src/migrations/NNNN_what.sql`), additive, applied in order by the API's own runner, which refuses an edited applied file.
- The platform admin module uses its own database role (`mediflow_platform`) with no grant on patient data.
- Money is minor units, instants are UTC ISO strings, and prices are effective-dated so issued bills never change.

## The spine every clinical module shares

| Concept           | Rule                                                                                               |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| Encounter         | Every clinical, ordering and billing record attaches to one (`opd`, `ipd`, `er`, `daycare`)        |
| Order             | Lab, imaging, procedure, medication and diet requests are all orders and emit `order.placed`       |
| Charge ledger     | Work posts charges to the encounter; invoices are assembled from charges, never written by modules |
| Append-only       | Stock ledger, administration, audit, results, signed documents: corrections are new entries        |
| State machines    | Orders, samples, admissions, beds, claims, discharge are enforced on the server                    |
| Concurrency-safe  | Bookings, beds, theatre slots and stock rely on constraints or row locks, not client checks        |
| Events, not calls | A module reaches another only through events or its `index.ts`                                     |

## Extending it

A feature is a folder, a manifest and one line in the registry (web: `registry/features.ts`; API: `app.ts`). It plugs in through five hooks only: the manifest, extension slots, domain events, its own tables and per-hospital settings. It ships dark behind a feature flag. Follow [`EXTENDING.md`](EXTENDING.md) and scaffold with `/new-feature`.

## Web app

- **Feature folders** (`apps/web/src/features/<name>/`) with a manifest; the registry turns manifests into routes, navigation and slots. Features import each other only through `index.ts`.
- **State:** server data (session, tenant config, `AccessPolicy`) in React Query with keys that start with the tenant id; Redux only for client workflow state; both reset on tenant switch and sign-out.
- **Access:** permissions, never role names (`usePermission`, `<Can>`, route `requires`). The server is the source of truth.
- **Contract:** the API writes `packages/contract/api.openapi.json`, merged with `planned.openapi.json` into `openapi.json`; the web client types are generated from it (`pnpm gen:api`). The web app runs on an MSW mock by default.
- **Shared building blocks** in `shared/ui` (`DataGrid`, form kit, charts, dialogs, `Calendar`). Bundle budgets are in [`PERFORMANCE.md`](PERFORMANCE.md).

## Background work and live data

- **Jobs:** `core/jobs` (pg-boss in production, in memory in tests): report runs, malware scans, retention sweeps, audit partitions and seals, outbox dispatch.
- **Live:** server-sent events over Postgres LISTEN/NOTIFY (`core/live`).
- **Files:** the `FileStore` interface in `core/files`; a local folder today, an S3 adapter with signed URLs behind `S3_DIRECT_LINKS`. Downloads use signed links.
- **Reports** read from a replica pool when one is configured.

## Security posture in short

Tenant isolation by RLS and server-side sessions; Argon2id passwords and TOTP; per-address and per-tenant rate limits; strict CORS and security headers; log redaction and no request bodies logged for patient routes; no PHI in browser storage or error reports; an immutable, sealed audit log. Details: [`THREAT_MODEL.md`](THREAT_MODEL.md), [`COMPLIANCE.md`](COMPLIANCE.md), [`runbooks/audit-seal-bucket.md`](runbooks/audit-seal-bucket.md).

## Where to go next

| Need                                 | Read                                                           |
| ------------------------------------ | -------------------------------------------------------------- |
| Run it and tour the code             | [`runbooks/local-onboarding.md`](runbooks/local-onboarding.md) |
| Why a technology was chosen          | [`ARCHITECTURE.md`](ARCHITECTURE.md)                           |
| Add a module, slot or event          | [`EXTENDING.md`](EXTENDING.md)                                 |
| Speed, budgets, load                 | [`PERFORMANCE.md`](PERFORMANCE.md)                             |
| Onboard a hospital, handle incidents | [`runbooks/`](runbooks/README.md)                              |
| What is built and what is missing    | [`STATUS.md`](STATUS.md)                                       |

Not yet written: deploy, rollback and restore. They wait for the CD pipeline (#146) and are tracked in #148.
