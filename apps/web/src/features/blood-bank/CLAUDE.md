# Blood bank (web): module notes

What was decided for this module in the web app (#196, first slice). The root `CLAUDE.md` wins where the two disagree. The API is in `apps/api/src/features/operations/CLAUDE.md` (blood bank).

## What exists

**The unit list** at `/blood-bank`, behind the `bloodbank` switch and `bloodUnit:read`. Units as a `DataGrid` (unit number names the row) from `GET /blood-units` one server page at a time (soonest expiry first), filtered by status (default Available), group and component. Above it, the stock that can be given now from `GET /blood-units/stock`. Both are read again every 20 s.

- **Moves** use `POST /blood-units/{unitId}/move` with the unit's `version` and an Idempotency-Key. The bank's side needs `bloodUnit:manage` (send to testing, clear for stock, discard, record expiry, register a unit); the ward's side needs `bloodUnit:issue` (reserve, release, issue, record transfusion). The action table is `allowedMoves` in `schemas.ts`, the same table as the server's; a move the status does not allow is `aria-disabled`. Reserving past a unit's date is disabled, recording expiry only once the date has passed.
- **Dialogs** (`shared/ui/dialog`): register (dates are typed on the hospital's clock and sent as instants through `zonedToUtc`), reserve (a patient chosen with `PatientSearch`, sent by id), discard (a reason is required and kept in the unit's history), and a unit's history (`GET /blood-units/{unitId}`), where the patient is looked up by id with `usePatientName` and shows "Not available to you" without `patient:read`.
- `conflict` and `invalid_transition` read "Someone else changed this unit first".

## Not here yet (the rest of #196)

Donor registry and collection, cross-match, transfusion reaction records, and a donor-to-recipient trace. The API has no donors, cross-match or reaction tables yet (`apps/api/src/features/operations/CLAUDE.md`, "Not here"); this slice is the unit lifecycle the API has. A patient's blood group is also missing, so reserving does not check compatibility.

## Decisions

- The list never names a patient; only the history dialog does, from the patient's own record.
- The mock (`mocks/handlers/blood-bank.ts`) seeds an available and a testing unit for the sample hospital; only it has `bloodbank` on.
