# Blood bank (web): module notes

What was decided for this module in the web app (#196, first slice). The root `CLAUDE.md` wins where the two disagree. The API is in `apps/api/src/features/operations/CLAUDE.md` (blood bank).

## What exists

**The unit list** at `/blood-bank`, behind the `bloodbank` switch and `bloodUnit:read`. Units as a `DataGrid` (unit number names the row) from `GET /blood-units` one server page at a time (soonest expiry first), filtered by status (default Available), group and component. Above it, the stock that can be given now from `GET /blood-units/stock`. Both are read again every 20 s.

- **Moves** use `POST /blood-units/{unitId}/move` with the unit's `version` and an Idempotency-Key. The bank's side needs `bloodUnit:manage` (send to testing, clear for stock, discard, record expiry, register a unit); the ward's side needs `bloodUnit:issue` (reserve, release, issue, record transfusion). The action table is `allowedMoves` in `schemas.ts`, the same table as the server's; a move the status does not allow is `aria-disabled`. Reserving past a unit's date is disabled, recording expiry only once the date has passed.
- **Dialogs** (`shared/ui/dialog`): register (dates are typed on the hospital's clock and sent as instants through `zonedToUtc`), reserve (a patient chosen with `PatientSearch`, sent by id), discard (a reason is required and kept in the unit's history), and a unit's history (`GET /blood-units/{unitId}`), where the patient is looked up by id with `usePatientName` and shows "Not available to you" without `patient:read`.
- `conflict` and `invalid_transition` read "Someone else changed this unit first".

## Second slice, part 1 (#586): screening, cross-match, reactions, trace

All on the Units screen, on the operations API (`bloodtesting.ts`, `bloodcompat.ts`, `bloodreactions.ts`).

- **Screening** (`bloodUnit:test`, `TestingDialogs.tsx`): "Record screening" on a unit in testing that is still `pending`: five selects (HIV, hepatitis B and C, syphilis, malaria), negative or reactive, recorded once. A reactive choice shows a warning (a live region that is always on the page) that the unit is discarded and its donor deferred; the done message says so afterwards. "Clear for stock" is `aria-disabled` unless `screeningStatus === 'cleared'` (`allowedMoves`); the server still answers 409 `screening_required`.
- **Cross-match** (`bloodUnit:test`): "Cross-match" on an available unit not past its date. A patient from `PatientSearch`, the patient's blood group beside it (`GET /patients/{id}/blood-group`, needs `patient.bloodGroup:read`; without it the dialog says it is not available to the caller, it does not guess), the result (compatible or incompatible) and the 72-hour note. 422 `abo_incompatible` and `blood_group_unknown` are said in words. The ABO rule lives on the server only; the client never decides compatibility.
- **Reserve** reads `POST /blood/compatible-units` for the chosen patient and the unit's component and shows the unit's latest cross-match (valid until, older than 72 hours, incompatible, none). It does not block the button: the server's 409 `crossmatch_required` or `screening_required` is mapped to a plain message (`refusal.ts`).
- **Compatible units for a patient** (`CompatiblePanel.tsx`): a section on the page, `bloodUnit:read` only. The patient and a component give the available units that fit, soonest expiry first, each with a `StatusBadge` for its cross-match. Its live region is `aria-live`, not `role="status"`, so the page keeps one status line.
- **Reactions** (`transfusionReaction:record`, `ReactionDialogs.tsx`): "Record reaction" on an issued or transfused unit, for the patient the unit went to (`unit.patientId`). Kind, severity, when the transfusion started and the reaction began (hospital clock), actions taken. A severe or hemolytic reaction shows a notice that the other units of the same collection are held; the done message counts `heldUnitIds`. An update (note, optionally a higher severity) is added from the trace; the severity select lists only levels above the current one, and 422 `severity_not_raised` is mapped.
- **Trace** (`transfusionReaction:read`): donor number and group, and the donor's name only when the API sends `fullName` (it needs `bloodDonor:read`); collection date, screening outcome, every move, the cross-matches (patients by `PatientLabel`), the recipient (id looked up with `usePatientName`) and the reactions with their updates. Reactions are shown only here: there is no Reactions tab. `GET /transfusion-reactions` (a list with filters) exists in the contract and is not used yet.
- **Mock** (`mocks/handlers/blood-bank.ts`): units in testing (BU-0002), available (BU-0001), issued (BU-0003, to `pth_00001`) and reserved (BU-0004, same collection as BU-0003). A mock patient's blood group follows its number (`groupOf`: pth_00001 is O+); the ABO and Rh rule there is a stand-in for the server's. A screening happens once per unit; clearing and reserving are gated as the server gates them; a cross-match lasts 72 hours.

## Not here yet

Donor registry and collection, and the patient's blood group tab (part 2 of #586). A list of all reactions, notifying the recipient's doctor and recalling cleared units of a reactive donor.

## Decisions

- The list never names a patient; only the history dialog does, from the patient's own record.
- The mock (`mocks/handlers/blood-bank.ts`) seeds an available and a testing unit for the sample hospital; only it has `bloodbank` on.
