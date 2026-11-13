# Release R2 hardening (DS-06, #170)

Checklist and runbook for the inpatient release (admissions, nursing, inpatient billing). Done on
2026-11-13 for what needs no cloud account; the rest is listed at the end.

## Security and tenant isolation review

Scope: `admissions` (reservations, discharge plan, summary), `nursing` (vitals, medication chart,
notes, fluids, care plans, diet, stock requests), billing for a stay (running bill, deposits,
settlement, bed days, discharge policy), their migrations and web screens. Checked with the
`/tenant-safety-check` and `/phi-check` lists.

Clean: every new table has `tenant_id`, forced RLS and composite `(tenant_id, id)` foreign keys; raw-id
lookups run inside the RLS transaction and answer one 404; every route declares permissions and the
feature flag; writes take idempotency keys; deposit, refund and apply lock the admission row; nursing
records and signed summaries are append-only by trigger; the discharge gate cannot be bypassed by
closing the encounter; the bed-day job runs one transaction per hospital and posts once per
admission and date; no PHI in URLs, events, logs or browser storage; web query keys carry `tenantId`.

Fixed in #170:

- The settlement (the discharge gate) now counts bed days the hourly job has not posted yet as
  unbilled, so `block` and `warn` cannot be passed on a bill that is about to grow.
- A payment made from a deposit cannot be refunded through `POST /payments/{id}/refunds` (409
  `deposit_payment`); it is paid back as a deposit, which keeps the deposit ledger right.

Open, as follow-up issues: scope on `admission:read` for the bed board and the stay bill routes;
one `discharge:clear` permission for nursing, pharmacy and lab clearances; advice note and attendant
phone in every list row; append-only triggers on the deposit tables; discharge policy and override
sharing `invoice:adjust`; the running bill pricing each unposted day with its own query; cancelling
an admission that already has bed charges.

## Full journey regression

- OPD: `apps/web/e2e/critical-flows.spec.ts` (registration to a paid invoice), plus the queue,
  clinical, lab, pharmacy and billing specs.
- IPD: `admissions.spec.ts` (admit, transfer, bed board), `nursing.spec.ts` (vitals, diet, dose, round
  note), `discharge.spec.ts` (admit, clearances, summary, final bill, discharge) at desktop, tablet and
  phone. API: `admissions.test.ts`, `reservations.test.ts`, `nursing.test.ts`, `care.test.ts`,
  `billing/stay.test.ts`. CI runs all of them; no single spec chains ward care into discharge, each
  half is covered by its own spec.

## Runbook

- Bed days are posted by the hourly job `billing.bed_days`. If it stops, the running bill and the
  settlement still show the due days as accruing and unbilled; run it again (it is idempotent, one
  charge per admission and date).
- Discharge policy (`off`, `warn`, `block`) is `PUT /billing/discharge-policy`; an override needs
  `invoice:adjust` and is audited.
- A deposit is returned only through `POST /admissions/{id}/deposits/refund`, never as a payment refund.
- An admission made by mistake is cancelled with a reason (`admission:cancel`); it needs no records.

## Not done: needs a cloud account

Performance and load test with inpatient data (k6 against staging, per hospital and mixed). Blocked
until a staging environment exists (#56, #140).
