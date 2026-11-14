# Operation theatre (web): module notes

What was decided for OT-01 (#176). The root `CLAUDE.md` wins where the two disagree. The API is `apps/api/src/features/theatre/`; read its `CLAUDE.md` too.

- **One route, one nav entry** ("Operation theatre", `theatre:read`, `/theatre`) behind the `theatre` switch. Two sections: **Surgeries** of one hospital day and the **Theatres**. Works at every width (cards on a phone).
- **The calendar is a day agenda**, not a grid: a day picker (previous, next, today, a date field) and a theatre filter over a cursor-paged `DataGrid` sorted by start as the server returns it. The day is the hospital's own midnight to midnight (`dayBoundsUtc` with the tenant's timezone) sent as `from` and `to`. A week or resource view would be desktop-only and is not built.
- **Permissions:** `surgery:schedule` books, reschedules and cancels; `surgery:perform` starts and completes; `theatre:manage` adds, renames and archives theatres. Buttons and row actions use `requires`, so they are absent without the permission. A row's moves follow the server's table (`allowedMoves`): scheduled to in progress or cancelled, in progress to completed.
- **Conflicts are the server's.** The UI never checks for overlaps; it says the server's `room_taken`, `surgeon_busy` and `patient_busy` (409) in words, and `in_the_past`, `invalid_time`, `version_conflict` and `invalid_transition` likewise. The only client check is that the end is after the start on the same day. A booking is within one hospital day in the form (a surgery over midnight is not bookable here; the API allows up to 24 hours).
- **Surgeon** is a doctor profile id chosen from `useDoctorOptions` (needs `doctor:read` and the doctors switch; without them the select is empty and the grid says "Surgeon"). **Patient** is chosen with `PatientSearch`; only the id is sent and the grid names the patient through `usePatientName` ("Patient on record" without `patient:read`). The procedure is free text plus an optional `ServiceSearch` of category `procedure` (sent as `serviceId`, for the later charge).
- **Idempotency:** every POST sends one key per identical body (`useAttempt`). Moves send the `version` read; room updates (PATCH) send the version and no key.
- **Refresh:** the day is read again every 30 seconds; every mutation invalidates the tenant's surgery (or theatre) keys.
- **Mock:** `mocks/handlers/theatre.ts` seeds two theatres and one surgery on `SEEDED_DAY` (2030-01-15, 09:30 to 11:00 on the hospital's clock) so it is never in the past, and refuses overlaps like the database does. The clinic has the switch off.
- **Not built:** the team (anaesthetists, nurses; the API has only a surgeon), linking to the admission, turnover time between cases, a week view, implant serial numbers and a count sheet (OT-04), the charges in the mock (the mock posts none; the real API does).

## Checklist and anaesthesia record (OT-02, #177)

- **Against the real API** since #872 (`periop` in `apps/api/src/features/theatre`); the mock keeps the same shape.
- **A row action** ("Checklist and anaesthesia", `theatre:read`, hidden for cancelled surgeries) opens `PeriopDialog`: one record per surgery, three sections (fitness, checklist, anaesthesia). Writing needs `surgery:perform` and a scheduled or in-progress surgery; otherwise the dialog is read-only. No new permission: a separate anaesthetist permission is a follow-up.
- **Checklist:** twelve steps in four phases (`CHECKLIST_PHASES` in `schemas.ts`): before the day (consent, site marked, fasting), sign in, time out, sign out (WHO). A phase opens when every step of the earlier ones is done (the server answers 409 `phase_incomplete`; the UI shows the button as `aria-disabled`). The time and the signer are taken by the server; a step is never undone, a repeat returns the first entry. Consent here is a confirmed step, not a link to a signed consent from the consents feature.
- **Anaesthesia:** a draft replaced on each save, then signed once (`already_signed` after that). Signing needs a saved draft with no unsaved edits. Start and end times and a vitals chart are not built.
- Every write answers with the whole record, which replaces the cached one (`periopKeys`); the record is re-read every 30 seconds.

## Operation note, stock used and charges (#178)

- A second row action, **Operation note and stock** (`theatre:read`, not for a cancelled surgery), opens `OperationDialog`: the **visit**, the **note** and the **stock used**. `surgery:perform` writes the note and the stock; `surgery:schedule` links the visit.
- **Visit:** a surgery is charged to an encounter of the same patient. It is chosen from the patient's open visits (`useEncounters` from clinical, which needs the clinical module and `encounter:read`; without it the select is empty) while the surgery is scheduled or in progress. With no visit nothing is charged, and the dialog says so. Linking changes the surgery's version (the day's list is read again).
- **Note:** procedure performed, findings, steps and technique, complications, blood loss, specimens, post-operative plan. A draft replaced on each save, written once the surgery has started (also after it is completed), signed once (the server takes the signer and time); a signed note is corrected only by addenda. Signing needs the draft saved with no unsaved edits, as for anaesthesia. Every write answers with the whole record (`operationKeys`).
- **Stock used:** the item is found with `DrugSearch` (consumables included), the place from `usePlaces`, the batch from `useStock` for that item and place (expired batches are not offered; the server decides the rest). One batch and quantity at a time (the API takes up to 20 lines). Stock leaves the ledger when recorded; the list shows item, batch, place and time. `inventoryKeys` are invalidated after recording.
- **Mock:** `mocks/handlers/theatre.ts` keeps notes and stock used, and moves the inventory mock's stock (`mockStockOut`); it posts no charges.

## Returning stock used (#901)

- Each stock-used line with units left has a **Return to stock** button (`surgery:perform`, surgery started) that opens a small inline form: units (1 up to used less returned, checked in the form, and by the server as `over_return`) and a reason. It calls `POST .../consumables/{id}/return` with an idempotency key; the used list and the inventory keys are read again. Focus goes to the status line on success and back to the button on cancel.
- A line shows "N units returned to stock" or "All returned to stock" with an icon, from `returnedQuantity`. The billing `return_review` flag lives on the charge, not on the consumable, so it is not shown here (follow-up: the API would have to expose it).
- Mock: the return handler moves stock back through `mockStockIn` (source `theatre`, reason `theatre_return`); no charge is voided in the mock. Not in `e2e/responsive.spec.ts`: the dialog needs a started surgery on the seeded day; the unit test runs axe on it.

## Recovery and orders (OT-04, #179)

- A third row action, **Recovery and orders** (`theatre:read`, not for a cancelled surgery), opens `RecoveryDialog`: **recovery notes** and **orders**. Mock only: `GET` and `POST /theatre/surgeries/{id}/recovery` are in `planned.openapi.json` (`RecoveryRecord`, `RecoveryNote`), so the real policy still works but the call fails against the real API until it is built (follow-up).
- **Notes** are append-only (no edit, no delete; a correction is a new note), written with `surgery:perform` once the surgery has started: text, an optional pain score 0 to 10 and a condition (`in_recovery`, `ready_for_ward`). The server takes the author and time. Newest last; re-read every 30 seconds.
- **Orders** are not rebuilt: the dialog shows clinical's `EncounterOrders` (lab, imaging, procedure panels, each with its own permissions) for the visit the surgery is charged to. With no visit linked it says to link one under Operation note and stock.
- Not in `e2e/responsive.spec.ts` (needs a started surgery); the unit test runs axe on the dialog.
