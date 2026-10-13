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
    jobs/         # the job queue interface, pg-boss and in-memory implementations
    logging/      # pino options and redaction
    notifier/     # staff email: the Notifier interface, SMTP adapter, templates
    openapi/      # contract generation and its version
    outbox/       # domain events: request.emit, the dispatcher, the event list
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

- **Authentication runs as its own database role,** `mediflow_auth`, through `withAuthTransaction`. It can reach `users`, `user_identities`, `memberships`, `sessions` and the hospitals of the user it has identified, and has no grant on any table that holds hospital data. Do not grant it one. A tenant route (the app role) sees of the identity tables only what staff management needs, by column and by row (see Staff). Another feature may read a member's name through that same grant, as doctors does; do not widen the grant itself.
- **Call `identify(userId)` only once the user is proven** (a verified password or a valid session). Before that, memberships and hospitals are invisible.
- **The cookie holds a random token; the database holds its SHA-256 hash.** Never log, return or store the token itself. It is httpOnly, SameSite=Lax, and in production Secure with the `__Host-` prefix.
- **Sessions end** after `SESSION_IDLE_MINUTES` (30) without a request and after `SESSION_ABSOLUTE_HOURS` (12) regardless. The token is replaced every `SESSION_ROTATE_MINUTES` (15) and on a hospital switch. The replaced token works for 30 more seconds; seen after that, it revokes the session. Time is compared on the database clock.
- **A failed sign-in has one answer** (401 `invalid_credentials`) and costs the same hashing whether the email exists, the password is wrong, or the account is disabled or locked. Keep it that way: no "user not found", no early return.
- **Lockout and rate limit are separate.** `LOGIN_MAX_FAILURES` (5) wrong passwords lock the account for `LOGIN_LOCK_MINUTES` (15). `AUTH_RATE_LIMIT_PER_MINUTE` (10) limits sign-in attempts per client address; a route opts in with `config.rateLimit`. Behind a load balancer set `TRUST_PROXY=true`, or every client shares one address.
- **Requests that change something must come from the web app.** A hook refuses any non-GET request whose `Origin` is not `APP_BASE_URL` (or whose `Sec-Fetch-Site` is cross-site) with 403 `cross_site_request`. Never make a GET route change state.
- **Passwords:** Argon2id via `core/auth/password.ts` only. New passwords go through `passwordProblem` (at least 12 characters, no composition rules, obvious choices refused).
- **Links (invite, password reset)** carry a random token and the database its hash, like the session cookie. A link works once and expires (`INVITE_TTL_HOURS` 168, `PASSWORD_RESET_TTL_MINUTES` 30). Every way a link can be wrong has one answer, 400 `invalid_token`. A refused password does not use the link up.
- **Inviting** is `issueInvite(client, config, ...)`, and it runs in the hospital's transaction (`request.txClient`), not the auth one: the hospital is the transaction's own tenant, never an argument. Call `sendInvite` after the commit (`request.afterCommit`). `POST /invites` in `features/staff` does both. Accepting is the only way a membership is created, and a database policy refuses one that has no open invite for that person, hospital and role.
- **Forgot password** always answers 204 and sends the email after the response, so neither the answer nor its timing shows whether the account exists. A reset ends every session of the user and leaves the second factor alone.
- **Second factor:** TOTP through `core/auth/mfa.ts` only. Secrets are encrypted with `MFA_ENCRYPTION_KEY` and bound to the user; a code is accepted once; recovery codes are stored hashed and used once. Sign-in takes the code in the same request as the password (`code`), and a wrong code counts toward the lockout. Changing the second factor needs the password again.
- **Whether a hospital uses the second factor is two switches in `tenant_features`,** both off unless set: `mfa` offers it to the staff, and `mfa_required` (which counts only with `mfa`) makes it compulsory. `resolveSession` works out on every request whether the user is held to the rule and has no authenticator (`session.mfaPending`), and the access guard then refuses every tenant route with 403 `mfa_required`. Session routes are not tenant routes, so setting one up, switching hospital and signing out stay within reach, and setting one up counts from the next request. `GET /auth/mfa/requirement` tells the web app what the active hospital requires. The one tenant route that still answers is the policy (`config.openWhileMfaPending`), so an open tab learns that the rule was turned on; do not set that on a route that returns hospital data. A session resolver must say `mfaPending`, and one that does not is treated as pending. Confirming an authenticator ends the user's other sessions, which were opened with the password alone. A person who already has an authenticator is asked for a code at sign-in whatever the hospital's switches say.
- **In tests,** `createUser`, `addMembership` and `deleteUsers` from `test/helpers.ts`; sign in through `/auth/login` and pass the cookie. See `core/auth/auth.test.ts`, and `core/auth/account.test.ts` for links and codes.

## Notifications

- **Send through `app.notifier`,** never a mail library: `app.notifier.send({ to, template, data })`. A message is a template name and its data, never a raw subject or body.
- **Staff only.** The system does not contact patients in v1. An email carries the minimum: one link and when it expires. No patient data and no clinical detail, in any template.
- **Links are built from `APP_BASE_URL`.** A template is given a path (`/invite?token=...`), never a URL, and a link that would leave the web app is refused.
- **Adding a template:** add its data shape to `TemplateData` and its renderer in `core/notifier/templates.ts`, with a test. HTML is escaped by the layout; emails carry no images, scripts or other remote content.
- **Adding a provider or a channel** (SES, SMS, WhatsApp) is a new implementation of the `Notifier` interface. Callers do not change.
- **In tests,** pass `createMemoryNotifier()` to `buildTestApp({ notifier })` and assert on `notifier.sent`. Only the notifier's own test talks to Mailpit.
- **Do not log recipients.** A failed send throws `NotifierError` with a plain message; the provider's error, which can quote the address, is its `cause`.
- Sends are direct for now. They move onto the job queue (see Audit, events and jobs) in a later change, so a slow mail server cannot slow a request and a failed send is retried.

## Audit, events and jobs

- **Audit PHI access.** A route that reads or changes patient, clinical or billing data declares `config: { audit: { entity: 'patient' } }`; the action comes from the method (`read`, `create`, `update`, `delete`) and the record id from `params.id`. For anything else call `request.audit(action, entity, entityId?)`. Entries are written in the request's transaction just before it commits, only for responses below 400, and if the insert fails the request fails. Rows hold ids and codes, never field values. The table is append-only (no UPDATE or DELETE, enforced by grants and a trigger), partitioned by month (every partition rejects TRUNCATE too), and a daily job creates the coming months. A route with `config.audit` that is not a tenant route stops the app from starting.
- **Publish events with `await request.emit('patient.registered', id, { ...ids })`.** The event is written to `outbox` in the request's transaction, so a rolled-back request emits nothing. The name must be in `core/outbox/events.ts` (the list in the root CLAUDE.md). The payload holds ids and codes only.
- **Subscribe with `app.events.subscribe(event, handler)`** in the feature plugin. The handler gets `(message, tx)`: `tx` is a transaction bound to the event's hospital under the app role, so row-level security applies as in a request; it commits when the handler returns. Delivery is at least once, so handlers must be idempotent (`message.eventId` identifies the event). A poller (`OUTBOX_POLL_MS`) hands pending events to the queue; an event the queue refuses is retried up to `MAX_ATTEMPTS` times, then left in `outbox` with its `attempts` count.
- **Jobs go through `app.jobs`** (`send`, `work`, `schedule`), never pg-boss directly, so Redis can replace it. `JOBS_ENABLED=false` runs an in-process queue and no poller: tests do this (`testConfig`), pass `jobQueue: new MemoryQueue()` to inspect it, call `app.events.dispatch()` and `queue.drain()` by hand.
- **pg-boss installs its own `pgboss` schema** the first time the queue starts, so the database login the API uses needs CREATE on the database. It is not created by a migration.
- **Background work runs as `mediflow_worker`** (`SET LOCAL ROLE`): the dispatcher reads every hospital's outbox rows, and the daily job calls `ensure_audit_partition`, a SECURITY DEFINER function only that role may execute. The API login therefore stays a non-owner (migration 0002) and still creates partitions. Migration 0007 grants the role to the migrating login only: in production, `GRANT mediflow_worker TO <api login>` as well (in development and CI the API connects as the migrating login). Tenant requests never use it.
- **Registration order matters:** `auditPlugin` is registered before `tenancyPlugin` because it writes in an `onSend` hook that must run before the tenancy hook commits.

## Rate limits and idempotency

- **Every tenant route is rate limited,** per hospital (`RATE_LIMIT_TENANT_PER_MINUTE`) and per user within it (`RATE_LIMIT_USER_PER_MINUTE`), by `core/ratelimit`. It runs right after the session and before the tenant transaction opens, and answers 429 `rate_limited` with `Retry-After`. The counters sit behind the `RateLimiter` interface: in-process now, so the limit is per API instance until a Redis implementation is passed as `buildApp({ rateLimiter })`. The sign-in routes keep their own per-address limit (core/auth). To send a header with an error, give `HttpError` a fourth argument.
- **Create and charge routes accept an Idempotency-Key.** Set `config: { idempotent: true }` on a tenant POST/PUT/PATCH/DELETE route, add `headers: IdempotencyHeaders` (core/idempotency/schema) and the 422 and 429 responses to its schema. A repeat with the same key (8 to 128 characters of `A-Za-z0-9_.:-`, scoped to the hospital and the user) returns the first status and body with `Idempotent-Replayed: true`; the same key with a different request is 422 `idempotency_key_reuse`. The key is claimed in the request's transaction, so a failed request leaves nothing and can be retried, and concurrent duplicates wait and then replay. `required: true` refuses a request without a key (payments).
- **What is stored of the response is the route's choice, and the default is the safe one:** `idempotent: true` keeps only the status and the new record's `id`, so a replay answers `{ "id": ... }`. Use `idempotent: { body: 'full' }` only when the response holds no patient data (`POST /invites` does, so for 24 hours the table holds the invitee's name and email). Never store a clinical or billing body: the table would become a second copy of PHI. What is stored is the response as the client received it, after the route's response schema, and an empty 204 replays as a 204. Rows expire after `IDEMPOTENCY_TTL_HOURS` (24) and a daily job removes them. A replay is not audited again.
- **Registration order matters:** `idempotencyPlugin` comes after `accessPlugin` (it needs the tenant transaction, and a caller without permission learns nothing about stored keys). `idempotencyStorePlugin` comes before `tenancyPlugin`, next to `auditPlugin`, because it saves the result in an `onSend` hook that must run before tenancy commits.
- **Limits count the user's bucket first:** a user over their limit is refused without using up the hospital's allowance, and the in-process `MemoryRateLimiter` counts per API instance.

## Patients

- **`features/patients`** is the first feature with patient data and the pattern for the next: `permissions.ts`, `schemas.ts` (TypeBox), `repository.ts` (SQL on `request.txClient`) and `routes.ts`. It is behind the `patients` module flag.
- **The MRN is assigned by the server** from `patient_mrn_counters`, one row per hospital, incremented in the registering request's own transaction: no gaps after a failure, no duplicates under concurrency. It is the hospital's initials and a seven-digit number (`SH-0000123`, so MRNs sort as text up to ten million per hospital) and never changes; a trigger refuses a change of hospital, MRN or registration details, and the app role has no DELETE on `patients`.
- **Search is `POST /patients/search`** with the term in the body, because it can be a name, a phone number or an MRN and must never be in a URL. Every word must appear in the name or MRN, in any order. `total` comes with the first page only.
- **The list is ordered and paged on plain stored columns** (`last_name_lower`, `first_name_lower`, `id`), and the cursor row's values are passed as parameters, so a deep page starts at the cursor through the index. The cursor holds the last row's id and the sort, no data; if that row is renamed between two pages, the next page starts from its new position.
- **`patient.contact:read` is a field-level permission.** Without it the phone is masked to its last four digits, email and address are left out, and contact details cannot be changed. Check it through `request.access.policy()`, since it is not one of the route's required permissions.
- **Searching by phone number needs `patient.contact:read` too.** Without it the term is matched against names and MRNs only: otherwise a masked number could be recovered digit by digit from which rows match.
- **Changing a record needs `patient:read` as well as `patient:update`,** because the answer is the whole record, and the narrower of the two scopes applies.
- **The duplicate check is a deliberate exception to scope and to the contact permission:** anyone who may register sees possible duplicates across the whole hospital, matched by name and birth date or by phone. That is what stops a second record for the same person. The matches are masked, carry no id, and the check is audited and rate limited.
- **Scope:** `own` means the patients the user registered, until encounters say whose patient someone is; `department` matches nothing yet.
- **A record outside the caller's hospital or scope is a 404,** the same answer as one that does not exist.
- **`POST /patients` requires an Idempotency-Key** and keeps only the id for a replay, so a replay answers `{ id }` and the client reads the record (which needs `patient:read`).
- **A birth date is checked against today at the hospital,** in its timezone, not the server's.
- **A change that sends what the record already has writes nothing and emits nothing.**
- **Every record has a `version`,** counted by a database trigger on each update. `PATCH /patients/{id}` requires `expectedVersion`, the version the caller read, and answers 409 `conflict` without changing anything when the record has moved on. The row is locked while the two are compared, so of two changes made from the same version exactly one goes through. Use the same pattern for any record two people can edit at once.
- **Audit:** record reads and updates through `config.audit`; create, search and duplicate check through `request.audit`. Events carry the patient id, and `patient.updated` the names of the changed fields, never values.
- **Unknown body fields are dropped by validation, not refused,** so a client cannot set `mrn`, `tenantId` or `id`.

## Staff

- **`features/staff`** is who works at the hospital: invitations (`routes.ts`), and the list, the roles someone may be invited into, deactivating, reactivating, ending sessions and withdrawing an invitation (`members.ts`, SQL in `repository.ts`). It has no module flag: a hospital cannot run without managing its staff. The web screen has its own `staff` switch.
- **What a hospital's own requests see of people (migration 0015):** the name and email address of its own members (`users`, three columns, rows by membership), its memberships with UPDATE on `status` only, and the sessions bound to it (which ones, never a token hash) with UPDATE on the two revoke columns. Row-level security does the limiting, as everywhere. Nothing else of an account is readable from a tenant route.
- **Deactivated is `memberships.status = 'suspended'`.** The row is kept, never deleted: accepting a new invitation cannot bring the membership back, and every check that asks for an active membership (the session resolver, the policy, switching hospital) refuses it from the next request. Deactivating also ends the sessions bound to the hospital and withdraws the open invitations the person sent. Their account and their other hospitals are untouched.
- **Nobody acts above themselves.** Deactivate, reactivate, revoke-sessions and withdrawing an invitation refuse (403 `role_not_allowed`) a target whose role holds a permission the caller's role lacks; `GET /staff/roles` lists only the roles the caller may give. All through `grantsWithin`.
- **A hospital is never left with nobody who can manage its staff.** Deactivating first locks, in user-id order, the active memberships whose role holds `staff:manage`, so two administrators deactivating each other at once are decided one after the other. Once the locks are held the caller is checked again: someone who was deactivated while their request waited is refused (403 `permission_denied`) and changes nothing. The same re-check runs in every member action. Nobody deactivates themselves (409 `cannot_deactivate_self`), and 409 `last_admin` remains as the last line: the target is the only manager left.
- **Signing someone out everywhere is a cut-off, not only a revocation.** A session is bound to one hospital at a time, so a hospital can find and revoke only the sessions bound to it (`revoked` counts those). A session at the hospital picker, or at another hospital, is covered by `memberships.sessions_valid_after` (migration 0016): the session resolver and `switchTenant` refuse, for this hospital, a session opened before that moment. The person signs in again; their other hospitals are untouched. Deactivating sets it too. For one's own account only the bound sessions are ended, since the session asking was opened before now.
- **A session that was ended stays ended:** a trigger refuses any change to `revoked_at` or `revoke_reason` once set, for every role.
- **The list lower-cases in the query,** for ordering and for search: a hospital's staff is hundreds of rows found through the tenant index. The cursor holds the last row's lower-cased name as the database made it, and its id.
- **Known limits:** the count of who can still manage staff goes by memberships, and a hospital's requests cannot see whether an account is disabled, so the manager left may be someone who cannot sign in; an invitation is judged when it is sent, so an inviter who later loses `staff:invite` (without being deactivated) leaves their open invitations standing; and a built-in role gains each new module's defaults at later deploys, so a narrow custom role can invite into a built-in role that later holds more.

## Doctors

- **`features/doctors`** is a member of staff's profile as a doctor, in one department, and their regular weekly working hours. Behind the `doctors` module flag (a hospital with it on has `departments` on too), with `doctor:read` for everyone who works with patients and `doctor:manage` for the admin.
- **A doctor is a member of this hospital, in a department of this hospital,** and the database says so: `(tenant_id, user_id)` references `memberships` and `(tenant_id, department_id)` references `departments`. The route checks first (an active member, a department that is not archived) to answer 400 `validation_failed`; the foreign keys hold whatever the route does.
- **Practising means the profile is active and the membership is.** A doctor whose membership the hospital deactivated is listed as inactive, so scheduling never offers someone who cannot sign in. The profile is not touched: reactivating the member brings the doctor back. `PATCH` does not make a profile active for someone who is not an active member.
- **One profile per person per hospital** (409 `doctor_exists`). A profile is made inactive, never deleted; someone who works at two hospitals has a profile at each.
- **The name is the account's,** read through the staff grant on `users`, and the lists are ordered by the name as the database lower-cases it.
- **Two versions.** The profile and the working hours are changed by different people at different times, so each has its own (`version`, `hours_version`), counted by the trigger only when what it stands for changed. `PATCH` takes the profile's, `PUT .../availability` the hours'.
- **Working hours** are sessions of a weekday in minutes after midnight at the hospital. `PUT` replaces the week. Sessions of a day may touch and may not overlap: the route says so with a 400, and an exclusion constraint (`doctor_hours_no_overlap`, which names the hospital too, as every constraint on a tenant table should) makes it true whatever the code does. A session cannot run past midnight yet.
- **`GET /doctors/candidates`** is the active members with no profile: who a profile can be made for. It needs `doctor:manage` and gives a name and an email address, nothing else of the account.

## Departments

- **`features/departments`** is reference data with no patient data: the pattern for a small catalog. It is behind the `departments` module flag, with `department:read` for the list and `department:manage` for every change.
- **A name is one department per hospital,** whatever its capitals, archived or not: a unique constraint on the stored lower-case name. The route checks first, to answer 409 `department_name_taken`, and the constraint settles two requests that arrive together.
- **Archived, never deleted.** The app role has no DELETE on the table. Archiving and restoring twice changes nothing and writes nothing.
- **The list is a GET with a cursor,** unlike the patient search: a department's name is not patient data. It is ordered on the stored lower-case name and the id, and the cursor holds those two values of the last row.
- **`(tenant_id, id)` is unique** so that another table refers to a department together with its hospital: `FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)`. A reference by id alone could name another hospital's department, because foreign keys are checked without row-level security. Do the same for any table other tables point at.
- **Changes are audited** through `request.audit('create' | 'update' | 'archive' | 'restore', 'department', id)`, although it is not patient data: who changed the hospital's structure is worth knowing.
- **`POST /departments` accepts an Idempotency-Key** and stores the whole answer for a replay, since it holds no patient data.

## Services and prices

- **`features/services`** is the price catalog: what the hospital charges for, and what each costs on a price list from a date. Reference data with no patient data. Behind the `services` module flag, with `service:read` for everyone who orders, performs or bills, and `service:manage` for the admin. Lab tests and bed categories refer to a service by id, and so will orders and charges.
- **The code is the service's identity on bills** and never changes: one per hospital, whatever its capitals, archived or not (409 `service_code_taken`), and a trigger refuses a change. Everything else about a service can change, and a charge will keep the name, category, tax class and price it was posted with.
- **The search is `POST /services/search`** with the term in the body (Searches in the root `CLAUDE.md`). Every word must be in the code or the name, in any order, matched against the stored lower-case `search_text` of the hospital's rows: no text index, as for patients. It is not audited: nothing in it is patient data.
- **A service comes with the price in force today on the standard list** (`currentPrice`), where today is the date at the hospital: `todayAtHospital` in `core/tenancy/today.ts`. Use it for any rule that compares a calendar date with today.
- **A price is never edited.** A new one takes over from its own date and the one before it gets its last day, the day before. The first price may start today; once one is in force a new one starts tomorrow or later, so what was charged this morning stays what it was (400 `validation_failed`). One price is scheduled at a time (409 `price_date_conflict`), and an archived service takes none (409 `service_archived`).
- **The database holds the rules, whatever the code does:** an exclusion constraint keeps two prices of a service on a list from covering the same day; a trigger lets only the last day and the withdrawal of a price change, and the last day only for days still to come, so a period that has ended stays as it was and none is made to end in the past (migration 0020); a price list that has prices cannot be removed; and the app role has no DELETE. The route locks the service first, so two requests take their turn and the second gets its 409 from the route, not from the constraint.
- **Withdrawing is a mark, not a removal.** `DELETE /services/{id}/prices/{priceId}` sets `withdrawn_at` on a price that has not started (409 `price_in_force` otherwise, and the trigger refuses it too), and the price before it loses its last day. A withdrawn price is not listed and answers 404 `price_not_found`; the row stays for whoever asks what was once scheduled.
- **Every hospital has one standard price list,** made with the hospital by a trigger on `tenants`, as its built-in roles are. Price lists are read-only for the app role. A price names its list, with the hospital in the foreign key, so lists for a payer or a room class can come later without changing a price.
- **Amounts are minor units in a `bigint`,** at most 10^12, read as a number. Dates are calendar dates (`date`), never instants.
- **Changes are audited** (`service`, `service_price`) and emit `master.changed` with the kind of record, what happened and, for an update, the names of the changed fields. Never a value. A price that comes with a new service (`priceMinor`) is audited and announced as a price of its own.
- **`POST /services` and `POST /services/{id}/prices` accept an Idempotency-Key** and store the whole answer for a replay, since it holds no patient data.

## Drugs and consumables

- **`features/drugs`** is what each medicine and consumable the hospital keeps is: no price and no stock, which go with the batch in the pharmacy. Reference data with no patient data. Behind the `drugs` module flag, with `drug:read` for those who prescribe, request, dispense and store, and `drug:manage` for the admin.
- **The same item is not added twice:** generic name, brand, form and strength, whatever the capitals, archived or not (409 `drug_exists`), by a unique constraint on stored lower-case columns in which a missing brand or strength is the empty text. Items that are only similar are the caller's to judge: `POST /drugs/duplicate-check` gives up to ten with the same generic name in the same form.
- **Schedule X and narcotic items are controlled, whatever is sent,** in the route and by a check constraint. The schedules are India's and fixed in the contract for now (Open Decisions in the root `CLAUDE.md`).
- **A change of `schedule` or `controlled` is audited as `reclassify`,** any other change as `update`, so taking an item out of a controlled schedule leaves its own trace. The event names the changed fields, never their values.
- **Optional text is absent, never empty:** an empty brand, strength or unit in a change removes it, and a null reorder level removes the level. The level is one schema with both types, not a union (see Rules).
- **Names are tidied and plain:** normalised (NFC), runs of spaces made one, and no control characters, zero-width space or direction overrides, so that two items that look the same are the same and a label reads as it was typed. The joiners Indic scripts need are allowed. The other catalogs do not do this yet (#306).
- **The search is `POST /drugs/search`,** by generic name then brand, every word in either, with filters for type, form, schedule and controlled. Like the services search it matches the stored `search_text` of the hospital's rows and is not audited.
- **A dispense, a stock entry and a prescription line will store what the item was** (name, brand, form, strength, schedule, controlled) when the line was written, so renaming or reclassifying here never changes history. That is theirs to do (M7, M10); nothing here keeps versions of an item.
- **`POST /drugs` accepts an Idempotency-Key** and stores the whole answer for a replay.

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
