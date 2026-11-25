# Local onboarding

Get the app running on your machine and find your way around the code. Nothing here needs a cloud account.

## Run it

1. Install Node 22 LTS (22.13 or newer), Git, and Docker Desktop (only for the API). Run `corepack enable` so the pinned pnpm is used. The package manager is pnpm only.
2. Clone into a short path outside OneDrive, then `pnpm install`.
3. **Web app on the mock API** (no database): `pnpm dev`, then open http://localhost:5173. It starts signed in as the sample hospital admin; `/?mockUser=none` starts signed out. Sample accounts are in `apps/web/src/mocks/db.ts`.
4. **Real API:** copy `.env.example` to `.env`, run `docker compose up -d` (Postgres, Mailpit at http://localhost:8025), then `pnpm --filter api db:migrate`, `pnpm --filter api db:seed` and `pnpm --filter api dev` (http://localhost:3000). Start the web app with `VITE_API_MOCKING=disabled`; Vite proxies `/api` to the API.
5. The full Windows instructions are in the root `README.md`; the command list is in `CLAUDE.md` (Commands).

The seed is for development only and refuses a remote database unless told otherwise. Never load real patient data outside production.

## Check your work

- `pnpm typecheck` and `vitest run <path>` for the code you changed. API tests need a database: `DATABASE_URL_TEST=<url> pnpm --filter api test <path>`.
- Leave the full suite, Playwright, builds and Lighthouse to CI. The dev machine class is two cores.
- `pnpm gen:api` after any route schema change; commit the generated contract files.
- `pnpm format:check` before pushing.

## Architecture tour

Read these in order; none is repeated here.

0. [`docs/OVERVIEW.md`](../OVERVIEW.md): the system on one page.
1. `CLAUDE.md`: the five non-negotiables, the stack, conventions.
2. [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md): technology choices, tenancy, platform admin.
3. [`docs/PRODUCT.md`](../PRODUCT.md): the patient journeys and the module map.

Where things live:

| Place                              | What                                                                       |
| ---------------------------------- | -------------------------------------------------------------------------- |
| `apps/web/src/features/<name>/`    | One folder per module: manifest, routes, hooks, `CLAUDE.md` with decisions |
| `apps/web/src/registry/`           | Manifests become routes, navigation and slots; one line per feature        |
| `apps/web/src/access/`, `tenancy/` | Permissions (never role names) and the active hospital                     |
| `apps/web/src/shared/ui/`          | `DataGrid`, form kit, charts, dialogs; see its `CLAUDE.md`                 |
| `apps/web/src/mocks/`              | The MSW mock API the web app runs on by default                            |
| `apps/api/src/features/<name>/`    | One Fastify plugin per module, with its own `CLAUDE.md`                    |
| `apps/api/src/core/`               | Session, tenant, access and audit hooks, outbox, jobs, files               |
| `apps/api/src/migrations/`         | Numbered plain SQL, additive, RLS in SQL                                   |
| `packages/contract/`               | OpenAPI spec and generated types shared by both apps                       |

Request path: session hook, tenant hook (`SET LOCAL app.tenant_id`, so row-level security filters every query), access hook (feature flag and permissions), audit, and events through the outbox.

Before changing a module read its `CLAUDE.md` in both apps. A new module follows [`docs/EXTENDING.md`](../EXTENDING.md). Work is tracked by GitHub issue: [`docs/WORKFLOW.md`](../WORKFLOW.md).
