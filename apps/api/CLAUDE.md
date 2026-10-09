# API (apps/api)

Backend-only rules. The root `CLAUDE.md` holds the architecture, the product scope and the security rules, and it wins where the two disagree.

## Running it

```bash
docker compose up -d              # Postgres and Mailpit (from the repo root)
pnpm --filter api db:migrate      # apply pending migrations to the dev database
pnpm --filter api dev             # Fastify with tsx watch on http://localhost:3000
pnpm --filter api test            # Vitest against the mediflow_test database
docker build -f apps/api/Dockerfile -t mediflow-api .   # from the repo root
```

Development and tests need no configuration: they default to the Docker Compose database. Production must set `DATABASE_URL`, and the process refuses to start without it.

## Layout

```
src/
  app.ts          # buildApp(config): core plugins, then one register line per feature
  server.ts       # loads config, listens, shuts down on SIGTERM
  core/
    config/       # environment, validated once at startup
    db/           # pool, Drizzle client, migration runner
    http/         # the error body and the error handlers
    logging/      # pino options and redaction
    openapi/      # contract generation and its version
    session/      # who is asking; route access levels
    tenancy/      # tenants tables, the per-request tenant transaction, GET /tenant
  features/<name>/
    index.ts        # the feature's Fastify plugin
    routes.ts       # TypeBox-schema routes
    permissions.ts  # permission ids and default role grants
    schema.ts       # Drizzle tables (tenant_id on every table)
    events.ts       # published and subscribed domain events
    settings.ts     # per-hospital settings schema
  migrations/     # NNNN_what.sql
test/             # global setup and helpers; tests live next to the code they cover
```

`core/access`, `core/audit`, `core/outbox`, `core/jobs` and `core/notifier` arrive with the issues that build them. A feature folder has only the files it needs: `features/health` has `index.ts` and `routes.ts`.

## Rules

- **Imports end in `.js`.** The package is native ESM (`module: NodeNext`), so `import { x } from './thing.js'` even though the file is `thing.ts`.
- **Every route declares its schemas.** Request and response TypeBox schemas and an `operationId`. Validation, types and the OpenAPI contract all come from that one definition.
- **Errors are thrown, not sent.** `throw new HttpError(status, 'stable_code', 'message for developers')`. The handler turns it into the standard body. Codes are stable and machine-readable; messages never contain patient data.
- **A feature is an encapsulated plugin.** Shared, app-wide plugins (database, later session and tenancy) use `fastify-plugin`; features do not.
- **Config comes from `app.config`,** never from `process.env` in feature code. Add a variable to the schema in `core/config`.

## Sessions, tenants and row-level security

- **A route is closed unless it says otherwise.** `config: { access: 'public' | 'session' | 'tenant' }`, and the default is `tenant`: a session with an active hospital. Health checks are `public`.
- **The session resolver is injected.** `buildApp(config, { resolveSession })`. Until authentication exists (M2) the default resolves nothing, so every non-public route answers 401. Tests pass `resolveTestSession` from `test/helpers.ts`.
- **A tenant route runs in the request's transaction.** The tenancy hook checks out a connection, begins, runs `SET LOCAL ROLE mediflow_app` and sets `app.tenant_id` from the session. Use `request.tx` for every query; never `app.database.pool` in a tenant route, which would run as the owner outside the tenant's scope. The transaction commits when the handler succeeds and rolls back when it throws.
- **The tenant comes from the session only.** Never from a path, query string, body or header. `X-Tenant-ID` is checked against the session and a mismatch is a 409 `tenant_mismatch`.
- **Do not add `WHERE tenant_id = ...` as the isolation mechanism.** Row-level security is the mechanism; a filter in application code is one forgotten clause away from a leak. (Filtering by tenant_id for index use is fine.)
- **Every tenant table follows the template:**
  ```sql
  CREATE TABLE things (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL REFERENCES tenants (id),
    ...
  );
  CREATE INDEX things_tenant_x ON things (tenant_id, x);
  SELECT enable_tenant_rls('things');            -- or enable_tenant_rls('things', 'SELECT')
  ```
  The function refuses a table without `tenant_id uuid NOT NULL` or without an index starting with `tenant_id`, then enables and forces row-level security, adds the `tenant_isolation` policy and grants the app role. A test fails if any table with a `tenant_id` column lacks any of that.
- **A statement Postgres refuses** (a policy violation or a missing grant, SQLSTATE 42501) is answered with 403 `forbidden` and logged as a warning. It means code tried to cross a boundary.
- **Cross-tenant tests are mandatory** for every tenant table and endpoint: see `test/tenancy.test.ts` for the pattern (`createTenant`, `asTenantSql`, `as(tenantId)`).
- **Production database roles:** migrations run as a privileged login. The API should connect as a separate login that is a member of `mediflow_app` and is neither a superuser nor the table owner, so that leaving the app role is impossible, not just unexpected. Local development and CI connect as the owner and rely on `SET LOCAL ROLE`.

## Contract

- The OpenAPI document is generated from route schemas. After changing a route or a schema, run `pnpm gen:api` from the repo root and commit `packages/contract`. A test and a CI step both fail if the committed files are stale.
- **Name what the web app needs.** A schema with an `$id` that is registered with `app.addSchema` and used through `ref(Schema)` appears once in the contract as `components.schemas.<$id>` and gets a named type in the client. Shared schemas are registered in `core/http/schemas.ts`; a feature registers its own in its plugin.
- **Errors:** `response: { 200: ref(Thing), ...errors(401, 403, 404) }`. Every error status uses the one `Error` body.
- **Lists:** query with `CursorQuery`, respond with `CursorPage(ref(Item), { $id: 'ItemPage' })`. There is no unpaginated list.
- **Implementing a planned endpoint:** delete it (and the schemas only it uses) from `packages/contract/planned.openapi.json` in the same PR. The merge refuses to run while both files define the same path or schema.
- **Breaking changes** (a removed path, operation, success response, schema or property; a changed type; a removed enum value; something newly required) need `CONTRACT_VERSION` raised in `core/openapi/plugin.ts`: the minor while it is 0.x, the major after. Update the web app in the same PR.

## Migrations

- One file per migration: `src/migrations/NNNN_what_it_does.sql`, the next number in sequence, lower snake case. To add one, create the file. Nothing else is edited.
- **Applied migrations are immutable.** A correction is a new migration. The runner stores each file's checksum and stops if an applied file was changed, deleted, or if a new file is numbered below an applied one.
- Each file runs in one transaction. Start a file with `-- migrate:no-transaction` only for statements Postgres forbids in a transaction (`CREATE INDEX CONCURRENTLY`).
- Migrations are additive: new tables, nullable columns, new indexes. Never change the meaning of an existing column.
- Row-level security policies, the `tenant_id` convention and exclusion constraints are written here as SQL.
- Deploys run `node dist/core/db/migrate-cli.js` as a separate step before the new version takes traffic.

## Logging

- Use `request.log` or `app.log`. `console` is a lint error.
- Request and response bodies are never logged, and the logged URL is the path without its query string.
- Fields that can hold patient data or secrets are redacted wherever they appear (`REDACTED_KEYS` in `core/logging/logger.ts`). Add to that list when a new sensitive field name appears.
- An unexpected error is logged by type and stack. Its message is dropped, because messages are built from data.

## Tests

- Tests run against a real Postgres, never a mock of it. Global setup applies the migrations to `mediflow_test`.
- Drive the app in-process with `buildTestApp()` and `app.inject`.
- Test files share one database and run one after another. A test that needs a clean slate creates what it needs and removes it, or uses its own scratch database as `migrate.test.ts` does.
- Cross-tenant tests are mandatory for every tenant table: tenant A must not read or write tenant B's rows, through the API or through SQL under the app role.
