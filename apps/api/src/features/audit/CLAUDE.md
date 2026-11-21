# Audit log (API)

The hospital's own audit trail (#1066, COMPLIANCE 3.4). The root and `apps/api` rules apply; the writer of the log is `core/audit`.

## What exists

- **`POST /audit/search`**, behind the `audit_log` switch (off by default) and `auditLog:read` with the scope `all`. A range of days at the hospital's clock is required and at most 92 days (422 `range_invalid`, `range_too_long`; a malformed or impossible date is a 400). Filters, all exact: `actorId`, `entity`, `entityId`, `action`. Newest first, a cursor page (the cursor keeps the row's time as text so microseconds survive; a bad one is 400 `invalid_cursor`). It is a POST so the filters stay out of logs.
- **An entry** is `id`, `at`, `actor` (`id` and the account's name from `users`, or null for work the system did itself), `action`, `entity`, `entityId` and `detail`. Record ids and short codes only: no patient is named and no field value is kept, because `audit_log` itself holds none. `denied.<action>` rows (a refused call) show as they are.
- **Reads go to the request's transaction (the primary),** over the `(tenant_id, at)` index, so a search sees what was written a moment ago. Row-level security filters the hospital; there is no tenant clause in the query beyond `app_tenant_id()` for the clock.
- **The read is itself audited:** `request.audit('read', 'audit_log')`, so who looked at the trail is in the trail.
- **The export** honours the same filters (#1100): `actorId`, `entity`, `entityId` and `action` ride on `POST /reports/audit_log/runs`, are kept on the run (`report_runs.filters`, jsonb) and applied by the job; any other report kind refuses them (422 `filters_not_supported`). It is not here: it is the `audit_log` report kind of `features/reports` (a stored run with a CSV, `auditLog:export` besides `report:read` and `report:export`). See that file.
- **Permissions:** `auditLog:read` and `auditLog:export`, the admin's by default; a custom role is given them on purpose. A new `auditLog:` prefix is in `OTHER_FEATURES` of `core/access/access.test.ts`.

## Known gaps

- A hospital's audit log older than `AUDIT_RETENTION_MONTHS` is archived to files and not searchable here (COMPLIANCE 3.3).
- Free text (#1101): `q` in the body matches part of the action or the kind of record, any case, `%` and `_` literal (within the day range, no index needed). It is not on the export. No filter by a range of entity ids; the other filters are exact.
- The routine review of the log (COMPLIANCE 3.6) is a process, not a feature.
- Tests: `audit.test.ts`.

- A run view and the run list carry `filters` (with the person's name), and the CSV opens with `from`, `to` and one line a filter (`filters,none` when there is none), a blank line, then the header (#1107).
