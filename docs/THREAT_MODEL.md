# Threat model and security review

Review for H-03 (#140), written 2026-11-18 against `main` at the time. It is a desk review of the code and migrations, not a test of a running system. Findings are issues; the register is at the end. Revisit it at each release and when a module is added (`/module-integration-check` and `/tenant-safety-check` are the per-change versions).

## Scope and assets

What is protected, most sensitive first:

1. **Patient records (PHI):** demographics, clinical notes, results, images, documents, claims.
2. **Money:** invoices, payments, refunds, stock, the drug register.
3. **Credentials and sessions:** passwords, authenticator secrets, session cookies.
4. **Tenant configuration:** roles, permissions, module flags, hospital limits.
5. **The audit log:** the evidence for everything above.

Out of scope until they exist: patient portal, device integrations, payer integrations, hosted infrastructure (no environment yet, so cloud and network threats are listed as requirements, not reviewed).

## Actors

| Actor                                 | Trust                                                                   |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Hospital staff with a role            | Trusted for what the role grants; may err or be curious (snooping)      |
| Staff of hospital A                   | Must never reach hospital B                                             |
| Platform admin                        | Trusted for tenants, not for patient data; every action audited         |
| Anonymous internet user               | Untrusted: login page, password reset, invite acceptance, signed links  |
| Stolen session or phished credentials | Assume it happens; limit the damage                                     |
| Malicious upload                      | Files are untrusted bytes                                               |
| Compromised dependency or CI          | Supply chain                                                            |
| Operator with database access         | Out of reach of application controls; handled by process and encryption |

## Trust boundaries and the controls at each

| Boundary               | Controls in place                                                                                                                                                                                                                                                       |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser to API         | httpOnly, `SameSite=Lax` cookie holding a random token (only its SHA-256 is stored); cross-site check on every non-GET request; Argon2id; TOTP; per-address limit on auth routes; strict request bodies (`strict-body`); 1 MiB body limit; typed schemas on every route |
| API to tenant data     | Session binds the tenant; the `tenant` hook runs `SET LOCAL app.tenant_id` and `SET LOCAL ROLE mediflow_app` (no bypass); `enable_tenant_rls()` enables and forces RLS with a policy using `app_tenant_id()`; with no tenant set every policy hides every row           |
| Route to permission    | A tenant route with no `permissions` stops the app starting; tenant flag and role permission must both hold; scopes (`own`, `department`) evaluated on the server; roles cannot grant beyond what the grantor holds                                                     |
| Handler to audit       | PHI reads and writes are audited in the same transaction; the audit table is append-only for the app role                                                                                                                                                               |
| Handler to files       | `FileStore` interface, size and type limits, malware scan job, signed time-limited download links, retention sweep                                                                                                                                                      |
| Cross-record flows     | Domain events through the transactional outbox, idempotent handlers; idempotency keys on money routes                                                                                                                                                                   |
| Logs and error reports | pino redaction of PHI fields, no bodies on patient routes; web errors rebuilt from an allowlist (`scrubEvent`), no messages sent; searches carrying patient terms use `POST` so they never reach URL logs                                                               |
| Web client             | No PHI in browser storage; cache cleared by `endSessionLocally`; no `dangerouslySetInnerHTML`; rich text is a sanitised JSON document                                                                                                                                   |

## Threats by cross-cutting area (STRIDE)

| Area                | Threat                                            | Mitigation today                                                                                              | Residual risk / gap                                                                                  |
| ------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Tenant isolation    | Spoofing a tenant, reading across hospitals       | Tenant only from the session; `X-Tenant-ID` is a consistency check; forced RLS                                | New tables rely on a developer calling `enable_tenant_rls()`: not enforced by a test (F-2)           |
| Tenant isolation    | A definer function bypasses RLS                   | Ten migrations define `SECURITY DEFINER` functions (patient search, deep links, merge); reviewed when written | No list of them or check of `search_path` and tenant argument (F-2)                                  |
| Authentication      | Credential stuffing, brute force                  | Argon2id, per-address limit, one answer for every failure                                                     | No per-account lockout or per-user limit (F-4); authenticator off by default per hospital            |
| Authentication      | Session theft                                     | httpOnly cookie, hashed at rest, idle timeout, revocation, cross-tab sign-out                                 | No device or IP binding; acceptable for v1                                                           |
| Authorization       | Privilege escalation through roles                | Nobody grants beyond what they hold; built-in roles protected; last manager kept                              | `PUT /roles/{roleId}` has no version check (known follow-up)                                         |
| Authorization       | Insider snooping on patients                      | Scopes, audit log of reads, restricted medico-legal reads                                                     | No anomaly review of the audit log; a hospital process, noted in the incident runbook                |
| Injection           | SQL injection                                     | Drizzle and parameterised queries; typed schemas                                                              | Raw SQL in search and definer functions should be reviewed in the pen test                           |
| Injection / XSS     | Stored script in notes or names                   | `PLAIN_TEXT` patterns on the API, rich text as JSON, no raw HTML, React escaping                              | No CSP as a second layer (F-1)                                                                       |
| Request forgery     | CSRF                                              | `SameSite=Lax` plus a cross-site check on non-GET                                                             | Keep GET free of side effects (convention)                                                           |
| Transport / headers | Clickjacking, sniffing, downgrade                 | None in the app                                                                                               | Helmet and strict CORS in the API; the SPA CSP is report-only (F-1)                                  |
| Uploads             | Malware, oversized or mistyped files, path tricks | Size and type limits, scan job, files by generated id behind `FileStore`, signed links                        | A file is held and never served until clean; ClamAV in production, retried with backoff (F-5, #1052) |
| Denial of service   | One user or hospital exhausts the API             | Body limit, cursor pagination, reports run as jobs with a quota                                               | No per-user or per-tenant limits (F-4)                                                               |
| Repudiation         | Staff deny an action                              | Audit log, append-only ledgers, signed documents never edited, amendments are new rows with author and reason | Audit retention (#481)                                                                               |
| Information leak    | PHI in logs, URLs, errors, exports                | Redaction, `POST` searches, scrubbed error reports, masked list columns                                       | Verify in the pen test; exports contain PHI by design and are permission-gated and audited           |
| Supply chain        | Vulnerable or hostile dependency                  | pnpm install scripts blocked, lockfile frozen, Dependabot, audit job in CI                                    | 19 findings open, CI gate is report-only (F-3)                                                       |
| Platform            | Platform admin reads patient data                 | No default access; separate `/platform` routes, authenticator required, audited                               | Break-glass access designed only; limits not enforced                                                |
| Secrets             | Keys in the repo or logs                          | Environment only; production needs `MFA_ENCRYPTION_KEY` and `REPORT_URL_SECRET`                               | Rotation procedure not written; wait for the deploy pipeline (#146)                                  |

## Threat model per module

Each row names the main risk for the module and the control that answers it. Every module below also inherits the cross-cutting controls above (tenant, permission, audit).

| Module (API folder)                               | Main threat                                                       | Control                                                                                                   |
| ------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Auth, session, platform (`core/auth`, `platform`) | Account takeover; platform admin abuse                            | Argon2id, TOTP, hashed tokens, invite and reset single use; every platform action audited                 |
| Roles and access (`roles`, `core/access`)         | Self-granted permissions                                          | Grant ceiling, protected built-in roles, last manager kept, policy tests                                  |
| Patients, merge                                   | Wrong-patient merge exposes records; MRN enumeration              | Merge audited and reversible in a window, legal hold carried; search through definer function with limits |
| Appointments, queue, triage                       | Public waiting-room board leaks identity                          | Display shows token and doctor, never a patient                                                           |
| Clinical (notes, orders, prescriptions)           | Altered notes; wrong drug despite allergy                         | Signed notes immutable, amendments appended; class-based allergy checks; own-patient scope for doctors    |
| Laboratory                                        | Unverified or altered result reaches a doctor                     | Results withheld until verified, corrections are new rows, critical values acknowledged                   |
| Radiology, documents                              | Malicious upload; image exposed by a long-lived link              | Scan job, size and type limits, signed short-lived links, retention sweep                                 |
| Pharmacy, inventory, purchasing, indents          | Stock theft by silent adjustment; controlled drugs diverted       | Append-only ledger is the only mover; adjustments and POs approved by a second person; drug register      |
| Billing, insurance, claims                        | Fraud: edited invoices, unapproved discounts, refund abuse        | Invoices immutable once issued, discount approval above a limit, idempotency keys, credit notes, audit    |
| Reports                                           | Bulk PHI export; guessable download                               | Permission and audit, replica reads, signed links with a secret, quota and retention                      |
| Admissions, nursing, emergency                    | Edited medico-legal record; bed double-booking                    | Revisions never overwritten, restricted audited reads, database constraints on beds                       |
| Theatre, operations (blood bank, ambulance)       | Signed anaesthesia record changed; blood unit released unscreened | Signed records locked, state machines on the server, checklist steps never undone                         |
| Imports, codes, templates                         | Hostile CSV (formula, oversized, bad encoding)                    | Row validation, size limits, problems reported per row; check formula injection on export in the pen test |
| Notifier, outbox, jobs                            | Event replay or a poisoned job                                    | Idempotent handlers, tenant on every event, retries bounded                                               |

## Review of tenant isolation tests

Checked 2026-11-18.

- 184 tables carry `tenant_id`. Every one calls `enable_tenant_rls()` except `sessions`, which enables and forces RLS with its own policy (`0004_auth.sql`). `tenants` has a select-only policy on `id`.
- 96 API test files exist; 47 mention a second hospital, and the mandatory cross-tenant tests are written per feature (for example documents, outbox, idempotency, billing stay). Every tenant table name appears in at least one test.
- **Gap:** nothing asserts the rule itself. A future migration that forgets `enable_tenant_rls()` passes CI. Proposed as a single catalog test (F-2).
- **Gap:** the `SECURITY DEFINER` functions (patient search, deep links, merge, claims follow-merge, among others) run as the owner and skip RLS by design. Each should be listed with the reason, and a test should show they take the tenant from `app_tenant_id()` and never from an argument alone (F-2).
- Web side: query keys carry the tenant and the cache is cleared on switch; covered by the foundation tests with coverage thresholds.

## CSP and security headers

Current state (#1048): `@fastify/helmet` on the API (`core/http/security-headers.ts`: a closed CSP, HSTS, nosniff, no-referrer, frame deny) and `apps/web/public/_headers` for the static host with the CSP in report-only. Still open: enforcing the CSP after the report-only phase; CORS is strict (#1061, `core/http/cors.ts`): the app's own origin plus `CORS_ALLOWED_ORIGINS`, never `*`; a preflight from another origin gets 403.

Target, to be decided and tested in F-1:

| Header                      | Value                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`   | `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' <sentry>; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'` (start in report-only; inline style is needed by Radix and Tailwind runtime values; check the report-only log before enforcing) |
| `Strict-Transport-Security` | `max-age=31536000; includeSubDomains` once served over TLS only                                                                                                                                                                                                                                                                                                     |
| `X-Content-Type-Options`    | `nosniff`                                                                                                                                                                                                                                                                                                                                                           |
| `Referrer-Policy`           | `no-referrer`                                                                                                                                                                                                                                                                                                                                                       |
| `Permissions-Policy`        | camera, microphone, geolocation off (barcode scanning, if added, asks again)                                                                                                                                                                                                                                                                                        |
| `Cache-Control`             | `no-store` on every authenticated API response; long immutable caching only for hashed assets                                                                                                                                                                                                                                                                       |
| API CORS                    | Strict (#1061): allowlist of `APP_BASE_URL` and `CORS_ALLOWED_ORIGINS`, never `*`; other origins get no CORS header and a 403 on preflight                                                                                                                                                                                                                          |

The PDF preview and print views use blob and data URLs; the report-only phase must cover them.

## Dependency audit

`pnpm audit` on 2026-11-18: 19 advisories (2 low, 11 moderate, 6 high). CI runs `pnpm audit --prod --audit-level high` as report-only.

| Package (path)                | Severity        | Reach                            | Action                                                              |
| ----------------------------- | --------------- | -------------------------------- | ------------------------------------------------------------------- |
| `undici` via `jsdom`          | up to high      | Tests only                       | Update jsdom or override to 7.30.1 or later                         |
| `basic-ftp` via `@lhci/cli`   | up to high      | CI only                          | Update `@lhci/cli` or override to 6.2.4 or later                    |
| `picomatch` via `lint-staged` | high            | Developer machines only          | Update `lint-staged`                                                |
| `minimatch` via `eslint`      | moderate        | Developer machines only          | Update eslint                                                       |
| `fast-uri` via `ajv` (API)    | low to moderate | Production API (schema compiler) | Override to 3.1.9 or later; it parses schema `$id`s, not user input |
| `react-router` 6              | moderate        | Shipped client                   | Known; CI gates at high; plan the move to 7 (F-3)                   |

None of the high findings reaches production code. They are tracked in F-3, which also removes `continue-on-error` so the gate blocks.

## External penetration test plan

Owner: a human with budget (cannot be done by Claude). Prerequisite: a staging environment with two seeded hospitals (#56, #146).

1. **When:** after the R1 modules and F-1 to F-4 are fixed, at least three weeks before the pilot go-live; re-test the fixes.
2. **Who:** an independent firm with healthcare web experience and CERT-In empanelment or equivalent; fixed price, written rules of engagement, NDA, no real patient data (seeded data only).
3. **Scope:** the SPA and API on staging; authentication and session; the role matrix; tenant isolation (the main goal: from a hospital A account, read or write anything of B); uploads and downloads; reports and exports; the platform area; the signed-link and deep-link routes.
4. **Out of scope:** denial-of-service load, social engineering, the hosting provider.
5. **Give them:** this document, the OpenAPI spec, two hospitals each with an admin, a doctor, a nurse and a receptionist, and a platform admin.
6. **Expect back:** a report with severity (CVSS), reproduction steps and advice; triage within a week into issues labelled `area:security`; criticals and highs fixed before go-live; a retest letter.
7. **After:** repeat yearly and after any major module (R2 and R3 add inpatient, payers and blood bank).

## Findings register

| ID  | Finding                                                                                                                                                                        | Severity | Issue        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ------------ |
| F-1 | No security headers, CSP or HSTS                                                                                                                                               | High     | #1048        |
| F-2 | No test that every tenant table has forced RLS; definer functions unlisted                                                                                                     | High     | #1049        |
| F-3 | 19 dependency advisories (none high in production code); audit gate is report-only                                                                                             | Medium   | #1050        |
| F-4 | No per-user or per-tenant rate limits; no account lockout                                                                                                                      | Medium   | #1051        |
| F-5 | Behaviour of uploads before a scan, and the production scanner (decided in #1052: held until clean, ClamAV, retries with backoff; a file that outlasts the retries stays held) | Medium   | #1052 (done) |
| F-6 | External penetration test not yet commissioned                                                                                                                                 | Medium   | #1054        |

Known items already tracked elsewhere: version check on `PUT /roles/{roleId}`, retention of account events (#481), disabling the authenticator on the account page (#252), enforcing hospital limits, break-glass access.
