# API (apps/api)

Backend-only rules. The root `CLAUDE.md` holds the architecture, the product scope and the security rules, and it wins where the two disagree.

## Running it

```bash
docker compose up -d              # Postgres and Mailpit (from the repo root)
pnpm --filter api db:migrate      # apply pending migrations, then default role permissions
pnpm --filter api db:seed         # sample hospitals, staff and patients (this machine only)
pnpm --filter api dev             # Fastify with tsx watch on http://localhost:3000
pnpm --filter api test            # Vitest against the mediflow_test database
docker build -f apps/api/Dockerfile -t mediflow-api .   # from the repo root
```

The seed creates staff who share a known password, so it refuses to run in production and against any database that is not on this machine (`localhost`, `127.0.0.1` or the Compose service `postgres`). For a throwaway database elsewhere, name its host: `pnpm --filter api db:seed --allow-host=<hostname>`.

Development and tests need no configuration: they default to the Docker Compose database. Production must set `DATABASE_URL`, `SMTP_URL`, `MAIL_FROM`, `APP_BASE_URL` and `MFA_ENCRYPTION_KEY` (`openssl rand -base64 32`), and the process refuses to start without them.

## Layout

```
src/
  app.ts          # buildApp(config): core plugins, then one register line per feature
  server.ts       # loads config, listens, shuts down on SIGTERM
  core/
    access/       # permission registry, the access policy, the guard, default grants
    auth/         # sign-in, sessions, passwords, invites, password reset, the second factor
    config/       # environment, validated once at startup
    audit/        # the audit log writer (request.audit, route config `audit`)
    db/           # pool, Drizzle client, migration runner
    http/         # the error body and the error handlers
    idempotency/  # idempotency keys for create routes
    imports/      # the registry of import kinds (app.importKinds)
    jobs/         # the job queue interface, pg-boss and in-memory implementations
    live/         # live updates: the bus (Postgres LISTEN/NOTIFY) and server-sent event streams
    logging/      # pino options and redaction
    notifier/     # staff email: the Notifier interface, SMTP adapter, templates
    openapi/      # contract generation and its version
    outbox/       # domain events: request.emit, the dispatcher, the event list
    ratelimit/    # per-tenant and per-user rate limits
    session/      # who is asking; route access levels
    tenancy/      # tenants tables, the per-request tenant transaction, GET /tenant
  features/<name>/
    index.ts        # the feature's Fastify plugin
    routes.ts       # TypeBox-schema routes
    permissions.ts  # permission ids and default role grants
    schemas.ts      # TypeBox request and response schemas, when routes.ts would get long
    repository.ts   # the feature's SQL, on request.txClient
    schema.ts       # Drizzle tables (tenant_id on every table), when the feature uses Drizzle
    events.ts       # published and subscribed domain events
    settings.ts     # per-hospital settings schema
  migrations/     # NNNN_what.sql
test/             # global setup and helpers; tests live next to the code they cover
```

A feature folder has only the files it needs: `features/health` has `index.ts` and `routes.ts`.

## Rules

- **Imports end in `.js`.** The package is native ESM (`module: NodeNext`), so `import { x } from './thing.js'` even though the file is `thing.ts`.
- **Every route declares its schemas.** Request and response TypeBox schemas and an `operationId`. Validation, types and the OpenAPI contract all come from that one definition.
- **A JSON body is checked for the types it was sent with** (`core/http/strict-body.ts`), before validation. The validator coerces types, which query strings and path parameters need because they are text; in a body it turned a `null` sent for a number into 0, `true` into 1 and a `null` sent for a text into the empty text, so a null price was a price of 0. A number, a boolean, a text, an object or a list sent as anything else is now a 400 `validation_failed`. Null passes only where the schema allows it.
- **A body schema is made of what that check can follow:** `type`, `properties`, `items` as one schema, and `ref()` to a registered schema. A route whose body uses anything else (`Type.Union`, `Type.Intersect`, `Type.Tuple`, `Type.Record`, a schema that contains itself) stops the app from starting. A value that may be null is one schema with both types, `Type.Unsafe<string | null>({ type: ['string', 'null'] })`, never a union: both types of a union pass the check, and the validator then coerces the value to its first branch, so a 0 became null or a null became 0. A fixed list of values is `StringEnum`. Responses, query strings and path parameters are not held to this.
- **Errors are thrown, not sent.** `throw new HttpError(status, 'stable_code', 'message for developers')`. The handler turns it into the standard body. Codes are stable and machine-readable; messages never contain patient data.
- **A feature is an encapsulated plugin.** Shared, app-wide plugins (database, later session and tenancy) use `fastify-plugin`; features do not.
- **No answer is to be stored, and no route has to say so.** A core hook (`core/http/cache.ts`) puts `Cache-Control: private, no-store` on every answer that has no `Cache-Control` of its own, errors and public routes included, so a record read on a shared hospital PC is not left in the browser's cache after sign-out. A route sets its own header only to say something else on purpose, and none does today; never one that lets an answer with a hospital's data be kept. An ETag does not need the browser's cache: the access policy is `private, no-store` with an ETag, and the web app keeps the policy and its ETag in memory and sends `If-None-Match` itself, so an unchanged policy is still a 304. Its own header counts for its answer only: a refusal (400 and up) is always `private, no-store` and carries no ETag. An address the router cannot read is answered before any hook, by `frameworkErrors` in `app.ts`, with the same header and the standard body.
- **Text a person types that is stored and printed is tidied and plain** (`core/http/text.ts`): its schema uses `PLAIN_TEXT` (or `PLAIN_LINES` for several lines) and the handler stores `tidyWithin`, `tidyOptional` or `tidyLinesOptional`, never a pattern that only refuses a NUL; a search term goes through `searchTerm` and is tidied, never refused; rows written before #306 are left as they are. The web app's forms hold a copy of the patterns (`text.test.ts` compares them). Why each character is refused or allowed, and the rules for writing a pattern: `core/http/CLAUDE.md`. Read it before changing the patterns or adding a field of this kind.
- **Config comes from `app.config`,** never from `process.env` in feature code. Add a variable to the schema in `core/config`.

## Sessions, tenants and row-level security

- **A route is closed unless it says otherwise.** `config: { access: 'public' | 'session' | 'tenant' }`, and the default is `tenant`: a session with an active hospital. Health checks are `public`. A tenant route must also state its `permissions` (see Access).
- **The session comes from the cookie.** The default resolver (`core/auth`) reads it. Tests that are not about authentication inject their own: `buildTestApp({ resolveSession: resolveTestSession })` from `test/helpers.ts`.
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
- **A text search cannot use a trigram or full-text index under row-level security.** Postgres only uses a clause as an index condition on a table with a policy when its operator is leakproof, and `LIKE`, `ILIKE`, `~` and `@@` are not. A search therefore finds the hospital's rows through a tenant-first b-tree index and matches the text against those (about 40 ms on 60,000 patients). The same goes for a function in the comparison: `lower(name) > $1` cannot be an index condition, so store the lower-case value in a generated column and compare that. Equality and ordering on plain columns are leakproof and do use an index, so look up an exact MRN or phone number that way when it matters. Do not add a trigram index to a tenant table: it slows writes and is never read (migration 0011).
- **Cross-tenant tests are mandatory** for every tenant table and endpoint: see `test/tenancy.test.ts` for the pattern (`createTenant`, `asTenantSql`, `as(tenantId)`).
- **Production database roles:** migrations run as a privileged login. The API should connect as a separate login that is a member of `mediflow_app` and is neither a superuser nor the table owner, so that leaving the app role is impossible, not just unexpected. Local development and CI connect as the owner and rely on `SET LOCAL ROLE`.

## Access

- **Every tenant route states what it requires:** `config: { permissions: ['patient:read'], feature: 'patients' }`. All listed permissions are needed. `permissions: []` means any active member of the hospital and has to be written out: a tenant route without `permissions` stops the app from starting, and so does a permission no feature declares.
- **The guard answers** 403 `feature_disabled` when the hospital has the module off and 403 `permission_denied` when the caller's role lacks a permission. It runs inside the hospital's transaction, after the session and tenancy hooks.
- **Never compare role names.** A role is a bundle of permissions that each hospital edits. Ask for a permission.
- **Scope is the handler's job.** The guard only establishes that the caller holds the permission. A handler that reads data narrows its query by `request.access.scope('patient:read')` (`all`, `own` or `department`).
- **A feature declares its permissions** in `permissions.ts` (id, description, default grants for built-in roles) and registers them in its plugin: `app.permissions.register('patients', PATIENT_PERMISSIONS)`.
- **Default grants are seed data.** `syncRoleDefaults` gives built-in roles the defaults they have not been offered yet, once per hospital, role and permission. A grant an admin removed is not put back; a new feature's defaults arrive at the next deploy. It runs as the second step of `db:migrate`, in the dev seed, and must be called when a hospital is created. Custom roles are never touched.
- **The policy version** is `tenant.role.revision`. Database triggers move the revision when a role, a grant or a module flag changes, so no code has to remember to. It is also the ETag of `GET /session/policy`.
- **Nobody hands on more than they hold.** `POST /invites` refuses (403 `role_not_allowed`) a role with a permission the caller's own role lacks, or the same permission at a wider scope: `grantsWithin(wanted, held)` in `core/access/policy.ts`. Use the same check wherever one person gives another access: reactivating a member, changing a member's role, editing a role's grants.
- **Roles and grants are tenant tables,** read-only for the app role until the role management API (BE-16). A membership or an invite can only name a role its hospital has.
- **Work that must follow the commit** (sending an email about a row just written) goes in `request.afterCommit(() => ...)`. It does not run if the request fails.
- **In tests,** declare a test feature in `extend` and call `grantRoleDefaults(app, tenant)`. See `core/access/access.test.ts`.

## Authentication

Sign-in, sessions, links, passwords and the second factor live in `core/auth`; its rules are in `core/auth/CLAUDE.md`, **read before any change there or to a route that signs in, sends a link or checks a code.** What holds everywhere: authentication runs as its own database role (`mediflow_auth`) through `withAuthTransaction`; the session cookie and every link carry a random token whose SHA-256 hash alone is stored, and the token is never logged, returned or stored; a failed sign-in or a bad link has one answer and one cost, whatever was wrong; a hook refuses a non-GET request from any origin but `APP_BASE_URL` (403 `cross_site_request`), so a GET route never changes state; passwords only through `core/auth/password.ts` (Argon2id) and TOTP only through `core/auth/mfa.ts`.

## Notifications

- **Send through `app.notifier`,** never a mail library: `app.notifier.send({ to, template, data })`. A message is a template name and its data, never a raw subject or body.
- **Staff only.** The system does not contact patients in v1. An email carries the minimum: one link and when it expires. No patient data and no clinical detail, in any template.
- **Links are built from `APP_BASE_URL`.** A template is given a path (`/invite?token=...`), never a URL, and a link that would leave the web app is refused.
- **Adding a template:** add its data shape to `TemplateData` and its renderer in `core/notifier/templates.ts`, with a test. HTML is escaped by the layout; emails carry no images, scripts or other remote content.
- **Adding a provider or a channel** (SES, SMS, WhatsApp) is a new implementation of the `Notifier` interface. Callers do not change.
- **In tests,** pass `createMemoryNotifier()` to `buildTestApp({ notifier })` and assert on `notifier.sent`. Email sent by a job also needs `jobQueue: new MemoryQueue()` and `queue.drain()` before reading what was sent; with `JOBS_ENABLED=false` and no drain, nothing is sent. Only the notifier's own test talks to Mailpit.
- **Do not log recipients.** A failed send throws `NotifierError` with a plain message; the provider's error, which can quote the address, is its `cause`.
- **Invitations and password resets are sent by jobs** (`core/auth/emails.ts`, #333), so a slow mail server never slows a request and a failed send is retried (five times, from 30 seconds and doubling with jitter, so the last retry comes 15 to 31 minutes after the first attempt; a reset link of 30 minutes may expire first, and then nothing is sent). The request saves the invite or the reset with a hash that matches no token and queues a job with ids only (the job id is the row's id); the job gives the row a new token, commits, then sends. So no address or token is ever in `pgboss.job`, which has no row-level security. Each attempt makes a new token, so only the newest link works, and a link that was used, withdrawn, replaced or expired before the job ran is not sent. A failure is logged as `email_send_failed` with the template and the job id, never the address or the error.
- **The job is queued after the commit, not through the outbox:** the outbox belongs to a hospital, and a password reset to none. If the process stops between the commit and the queueing, that one email is not sent; the person asks for a reset again, or the invitation is sent again. A new email of this kind follows the same shape: a row, a job of ids, the token made by the job.

## Audit, events and jobs

- **Audit PHI access.** A route that reads or changes patient, clinical or billing data declares `config: { audit: { entity: 'patient' } }`; the action comes from the method (`read`, `create`, `update`, `delete`) and the record id from `params.id`. For anything else call `request.audit(action, entity, entityId?)`. Entries are written in the request's transaction just before it commits, only for responses below 400, and if the insert fails the request fails. Rows hold ids and codes, never field values. The table is append-only (no UPDATE or DELETE, enforced by grants and a trigger), partitioned by month (every partition rejects TRUNCATE too), and a daily job creates the coming months. A route with `config.audit` that is not a tenant route stops the app from starting.
- **Publish events with `await request.emit('patient.registered', id, { ...ids })`.** The event is written to `outbox` in the request's transaction, so a rolled-back request emits nothing. The name must be in `core/outbox/events.ts` (the list in the root CLAUDE.md). The payload holds ids and codes only.
- **Subscribe with `app.events.subscribe(event, handler)`** in the feature plugin. The handler gets `(message, tx)`: `tx` is a transaction bound to the event's hospital under the app role, so row-level security applies as in a request; it commits when the handler returns. Delivery is at least once, so handlers must be idempotent (`message.eventId` identifies the event). A poller (`OUTBOX_POLL_MS`) hands pending events to the queue; an event the queue refuses is retried up to `MAX_ATTEMPTS` times, then left in `outbox` with its `attempts` count.
- **Jobs go through `app.jobs`** (`send`, `work`, `schedule`), never pg-boss directly, so Redis can replace it. `JOBS_ENABLED=false` runs an in-process queue and no poller: tests do this (`testConfig`), pass `jobQueue: new MemoryQueue()` to inspect it, call `app.events.dispatch()` and `queue.drain()` by hand.
- **pg-boss installs its own `pgboss` schema** the first time the queue starts, so the database login the API uses needs CREATE on the database. It is not created by a migration.
- **Background work runs as `mediflow_worker`** (`SET LOCAL ROLE`): the dispatcher reads every hospital's outbox rows, and the daily job calls `ensure_audit_partition`, a SECURITY DEFINER function only that role may execute. The API login therefore stays a non-owner (migration 0002) and still creates partitions. Migration 0007 grants the role to the migrating login only: in production, `GRANT mediflow_worker TO <api login>` as well (in development and CI the API connects as the migrating login). Tenant requests never use it.
- **Registration order matters:** `auditPlugin` is registered before `tenancyPlugin` because it writes in an `onSend` hook that must run before the tenancy hook commits.

## Live updates

- **A screen that must follow changes as they happen** (the queue board) gets a server-sent event stream: a tenant route whose handler is `app.live.stream(request, reply, { topic, event, filter })`. The route declares its `permissions` and `feature` as any other; the guard runs, then the request's transaction commits (`request.commitNow()`) and the reply is taken over, so an open stream holds no database connection.
- **Publish with `app.live.bus.publish(request.txClient, topic, { ...ids })`** in the transaction of the change: Postgres `NOTIFY` sends it when the transaction commits and never when it rolls back, to every API instance. The hospital is set in SQL from the transaction, never passed. A message says which record changed, never what it holds: the screen reads it again through its own audited route. Redis pub/sub can replace the bus behind `LiveBus` (`buildApp({ liveBus })`).
- **A stream checks its caller again** before sending events and at each 20-second keep-alive: the session row (not revoked, expired or idle, still at that hospital; read with `sessionStillHolds`, which never rotates the token, since a stream cannot send a new cookie), the user and membership, the hospital not suspended, the route's module and permissions, and the route's own `filter` (scope). Anything that no longer holds ends the stream. A check made within `LIVE_RECHECK_MS` (2 seconds; tests 0) is reused, so a burst of events costs one check per stream. A test resolver's session has no row and is taken to hold in tests only; its policy is still checked.
- **When the listening connection breaks,** every stream ends, since messages may have been missed: the browser opens it again and reads the screen afresh. The connection has TCP keep-alive, a 5-second connect timeout and a `select 1` every 20 seconds, so one the network dropped silently is noticed too. Streams end when the app closes, starting ones included. 503 `live_unavailable` when the bus cannot listen.
- **A stream writes nothing before its headers** (a message that arrives while the request commits waits for them), ends a client that leaves events unread for 30 seconds, and each one's keep-alive starts at a random point so a hospital's streams do not check at the same moment. One person may hold five streams at a hospital on one instance (429 `rate_limited` beyond that).
- **`DATABASE_URL` must reach Postgres directly or through a session-mode pooler:** `LISTEN` does not work through a transaction-mode PgBouncer. Postgres also queues the commits of transactions that `NOTIFY`; when that shows under load, Redis pub/sub replaces the bus (`docs/PERFORMANCE.md`).
- **In tests,** listen on a real port (`app.listen({ port: 0 })`) and read the stream with `fetch`; `app.inject` waits for the end of an answer. See `features/queue/queue.test.ts`.

## Rate limits and idempotency

- **Every tenant route is rate limited,** per hospital (`RATE_LIMIT_TENANT_PER_MINUTE`) and per user within it (`RATE_LIMIT_USER_PER_MINUTE`), by `core/ratelimit`. It runs right after the session and before the tenant transaction opens, and answers 429 `rate_limited` with `Retry-After`. The counters sit behind the `RateLimiter` interface: in-process now, so the limit is per API instance until a Redis implementation is passed as `buildApp({ rateLimiter })`. The sign-in routes keep their own per-address limit (core/auth). To send a header with an error, give `HttpError` a fourth argument.
- **Create and charge routes accept an Idempotency-Key.** Set `config: { idempotent: true }` on a tenant POST/PUT/PATCH/DELETE route, add `headers: IdempotencyHeaders` (core/idempotency/schema) and the 422 and 429 responses to its schema. A repeat with the same key (8 to 128 characters of `A-Za-z0-9_.:-`, scoped to the hospital and the user) returns the first status and body with `Idempotent-Replayed: true`; the same key with a different request is 422 `idempotency_key_reuse`. The key is claimed in the request's transaction, so a failed request leaves nothing and can be retried, and concurrent duplicates wait and then replay. `required: true` refuses a request without a key (payments).
- **What is stored of the response is the route's choice, and the default is the safe one:** `idempotent: true` keeps only the status and the new record's `id`, so a replay answers `{ "id": ... }`. Use `idempotent: { body: 'none' }` when the response has no single `id` and holds text that must not be kept a second time (a whole ward, with the notes on its blocked beds; a template, whose text a redaction may have to remove): only the status is kept, a repeat reaches the handler with `request.replayOf` set, and the handler checks that first and answers again with what is true now, doing no work. A route with no id in its path to find the record by sets `request.idempotentId` when it has made it: that id is kept, nothing else, and given back on a repeat (`POST /templates`). Never find the record of a repeat by a name: it may have changed since. Use `idempotent: { body: 'full' }` only when the response holds no patient data (`POST /invites` does, so for 24 hours the table holds the invitee's name and email). Never store a clinical or billing body: the table would become a second copy of PHI. What is stored is the response as the client received it, after the route's response schema, and an empty 204 replays as a 204. Rows expire after `IDEMPOTENCY_TTL_HOURS` (24) and a daily job removes them. A replay is not audited again, apart from what its handler records itself: a route that keeps no body and answers a repeat with the record as it is now calls `request.audit('read', ...)`, and that read is written (`appointments`).
- **Registration order matters:** `idempotencyPlugin` comes after `accessPlugin` (it needs the tenant transaction, and a caller without permission learns nothing about stored keys). `idempotencyStorePlugin` comes before `tenancyPlugin`, next to `auditPlugin`, because it saves the result in an `onSend` hook that must run before tenancy commits.
- **Limits count the user's bucket first:** a user over their limit is refused without using up the hospital's allowance, and the in-process `MemoryRateLimiter` counts per API instance.

## Features

What was decided for each feature's API is in `src/features/<name>/CLAUDE.md`, which Claude Code loads when a file of that folder is read: `patients` (patients), `staff` (staff), `doctors` (doctors), `departments` (departments), `services` (services and prices), `drugs` (drugs and consumables), `lab-tests` (lab tests), `wards` (wards, rooms and beds), `codes` (diagnosis and procedure codes), `templates` (document templates), `imports` (import centre), `appointments` (appointments), `queue` (the OPD token queue and its event stream), `triage` (vitals, ranges and allergies), `clinical` (encounters, notes, diagnoses, orders and prescriptions, referrals and follow-ups). **Read it before changing that feature, or before using it from another one** (its routes, its exports such as `app.importKinds`, or its tables).

## Contract

- The OpenAPI document is generated from route schemas. After changing a route or a schema, run `pnpm gen:api` from the repo root and commit `packages/contract`. A test and a CI step both fail if the committed files are stale.
- **Name what the web app needs.** A schema with an `$id` that is registered with `app.addSchema` and used through `ref(Schema)` appears once in the contract as `components.schemas.<$id>` and gets a named type in the client. Shared schemas are registered in `core/http/schemas.ts`; a feature registers its own in its plugin.
- **Errors:** `response: { 200: ref(Thing), ...errors(401, 403, 404) }`. Every error status uses the one `Error` body.
- **No `default` on a field of a request body schema.** The generated client makes such a field required. Say the default in the description. After `pnpm gen:api`, check the web app with `pnpm --filter web exec tsc -b --force`: the usual typecheck is incremental and can pass on a stale build.
- **The idempotency header is `idempotency-key`** in the generated client, lower case, and the web app sends it so.
- **Lists:** query with `CursorQuery`, respond with `CursorPage(ref(Item), { $id: 'ItemPage' })`. There is no unpaginated list.
- **Implementing a planned endpoint:** delete it (and the schemas only it uses) from `packages/contract/planned.openapi.json` in the same PR. The merge refuses to run while both files define the same path or schema.
- **Breaking changes** (a removed path, operation, success response, schema or property; a changed type; a removed enum value; something newly required) need `CONTRACT_VERSION` raised in `core/openapi/plugin.ts`: the minor while it is 0.x, the major after. Update the web app in the same PR.

## Migrations

- One file per migration: `src/migrations/NNNN_what_it_does.sql`, the next number in sequence, lower snake case. To add one, create the file. Nothing else is edited.
- **No `drizzle-kit`:** its workflow rewrites a journal and fills in generated files, which conflicts with the rule that existing migrations are never modified.
- **Applied migrations are immutable.** A correction is a new migration. The runner stores each file's checksum and stops if an applied file was changed, deleted, or if a new file is numbered below an applied one.
- Each file runs in one transaction. Start a file with `-- migrate:no-transaction` only for statements Postgres forbids in a transaction (`CREATE INDEX CONCURRENTLY`).
- Migrations are additive: new tables, nullable columns, new indexes. Never change the meaning of an existing column.
- Row-level security policies, the `tenant_id` convention and exclusion constraints are written here as SQL.
- Deploys run `node dist/core/db/migrate-cli.js` as a separate step before the new version takes traffic. It applies migrations and then the default role permissions, so it needs the same environment as the API itself.

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
