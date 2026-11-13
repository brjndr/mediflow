# Insurance API

What was decided for this feature's API (BE-28, #187). Claude Code loads it when a file of this folder is read. The web side is `apps/web/src/features/insurance/CLAUDE.md`.

**First slice only.** Delivered: payers, plans and rate agreements, a patient's policies, and pre-authorizations (migration 0098, switch `insurance`). Still in `packages/contract/planned.openapi.json` with the web mock behind them: the coverage split (#183), claims (#184) and corporate credit with receipts (#185). Delete each from the planned file when it lands.

- **Permissions:** `payer:read|manage`, `policy:read|manage`, `preauth:read|manage`. The admin holds all; the receptionist reads payers and manages policies and pre-authorizations (the "create/view" cell of the matrix). The claim, receivable and write-off permissions come with their slices.
- **Payers** (`insurer`, `tpa`, `corporate`): the code and kind never change (a trigger), the code is unique per hospital whatever its capitals (409 `duplicate_code`). `PATCH` sends the changed fields and the `version` (409 `version_conflict`); a contact field sent as `null` is cleared. The list is a `GET` with `q` (name or code), because nothing about a patient is searched here.
- **Plans** replace their terms as a whole: when any term or the services are sent, a limit or age left out is removed; `archived` alone changes nothing else. Services are kept by id in `payer_plan_services` (422 `unknown_service`, `duplicate_service`). An archived organisation takes no plan (409 `payer_archived`).
- **Rate agreements** are never edited: a trigger lets only `effective_to` change, and an exclusion constraint on closed date ranges (no end is open-ended) keeps one organisation's agreements apart (409 `agreement_overlap`, also when ending later runs into the next). A start in the past is judged on the hospital's clock (422 `starts_in_past`). The rates table is insert-only for the application role.
- **Policies** are ended, never edited or deleted (trigger). `status` is worked out per request: `ended`, else `expired` once `validTo` is before today at the hospital, else `active`. The same card on the same plan is on a record once while in force (partial unique index, 409 `duplicate_policy`). A patient the caller may not read, and one that does not exist, are the same 404 `patient_not_found`. Reads are audited per policy.
- **Pre-authorizations** go `submitted -> approved | rejected | cancelled`, once (trigger and handler, 409 `not_submitted`); `approvedMinor` exists exactly when approved (a CHECK; 422 without it). Documents are names only, as in the web app. `billedMinor` is the sum of the visit's charges that are not void, read from the charge ledger when the request is listed, so it is always current; a request with no visit has 0.
- **Idempotency:** creates require an `Idempotency-Key`; ending, deciding and withdrawing accept one.
- **No domain events yet.** `claim.submitted` and `claim.settled` are allowed in the outbox and are emitted by the claims slice.

## Proposed next slices

1. Coverage split (`GET|POST /encounters/{id}/coverage-split`): reads the charge ledger, the newest active policy, the plan's terms and the agreement in force.
2. Claims (`claims`, `claim_events`, the state machine, aging, `claim.submitted`, `claim.settled`, `claim:read|manage|writeoff`) and the document attachments by name, then export adapters for payer formats.
3. Corporate credit (`credit_accounts`, credit bills, receipts applied oldest first in one transaction, statement) with `receivable:read|manage|receipt`.
