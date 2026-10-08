---
name: module-integration-check
description: Verify a clinical, pharmacy, billing or other hospital module integrates with the shared architecture (Encounter, unified Order, charge ledger, domain events, state machines, append-only records). Use before finishing any module-level change in the HMS app.
---

# Module integration check

Review the current diff (`git diff`) and the module's design against "Product Scope: End-to-End Patient Journey" in CLAUDE.md. Report findings by file and line.

## Checklist

1. **Encounter spine:** every clinical, order and billing record references an `encounterId` (and `patientId`). No new visit, episode or admission concept that duplicates `Encounter`.
2. **Unified orders:** anything ordered (lab, imaging, procedure, medication, diet) is an `Order` created through the order API and emits `order.placed`. Consumer modules react to events and never call the ordering module directly.
3. **Charge ledger:** billable work posts `Charge` records priced from the effective price list. No module writes invoices or invoice lines directly.
4. **Master data by ID:** catalogs (services, drugs, tests, codes, beds) are referenced by ID, not copied or typed as free text. Large code sets are searched server-side.
5. **State machines:** statuses change only through backend-validated transitions. The UI offers only valid next actions.
6. **Concurrency:** double-booking, bed or theatre occupancy and stock decrements are protected by database constraints or row locks, and mutations that create or charge use an idempotency key.
7. **Append-only records:** stock ledger, medication administration, results, signed documents and audit entries are never updated or deleted. Corrections are new entries or addenda with author and reason.
8. **Events:** published and consumed events match the contract list, carry `tenantId`, are written through the outbox, and handlers are idempotent.
9. **Feature module hygiene:** feature flag off by default, permissions and default role grants registered, per-hospital settings declared, slots used instead of editing other modules, and no imports of another feature's internals.
10. **Tests:** two-tenant isolation, permission absent, flag off, invalid state transitions, concurrency, and one end-to-end journey test through the module.

## Output

List each violation with file, line, why it breaks the architecture, and the fix. If none, state which items were verified. Do not modify code unless asked.
