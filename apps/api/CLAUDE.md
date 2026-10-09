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

`core/session`, `core/tenancy`, `core/access`, `core/audit`, `core/outbox`, `core/jobs` and `core/notifier` arrive with the issues that build them. A feature folder has only the files it needs: `features/health` has `index.ts` and `routes.ts`.

## Rules

- **Imports end in `.js`.** The package is native ESM (`module: NodeNext`), so `import { x } from './thing.js'` even though the file is `thing.ts`.
- **Every route declares its schemas.** Request and response TypeBox schemas and an `operationId`. Validation, types and the OpenAPI contract all come from that one definition.
- **Errors are thrown, not sent.** `throw new HttpError(status, 'stable_code', 'message for developers')`. The handler turns it into the standard body. Codes are stable and machine-readable; messages never contain patient data.
- **A feature is an encapsulated plugin.** Shared, app-wide plugins (database, later session and tenancy) use `fastify-plugin`; features do not.
- **Config comes from `app.config`,** never from `process.env` in feature code. Add a variable to the schema in `core/config`.

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
