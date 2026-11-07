# Admissions (web): module notes

What was decided for this module in the web app. The root `CLAUDE.md` wins where the two disagree. The API is described in `apps/api/src/features/admissions/CLAUDE.md`; the beds themselves (wards, rooms, categories) are the `wards` module.

## What exists

**The bed board (#151)** at `/beds`, behind the `admissions` switch and `admission:read` (the API also needs `wards` on). Every bed in use as a `DataGrid` (cards on a phone, bed number as the title), by ward name and bed number, from `GET /beds/board` one server page at a time, filtered by ward and status. The occupant's name is shown and the MRN masked. A status is a word and an icon, and a blocked bed says why.

- **Live:** `GET /beds/events` is followed through `followEventStream` (`hooks/use-board.ts`). An event carries only `{ wardId }`; the board reads again (debounced 300 ms, at most 1 s behind a steady flow), and once each time the stream opens. A board filtered to one ward ignores other wards' events. Without a stream (403, 503 or a lost connection) it reads every 15 s and says so.
- **Actions per row:** "Mark being cleaned" (available) and "Mark ready" (cleaning) use `POST /beds/{bedId}/housekeeping` with the bed's `version` and an Idempotency-Key (`bed:update`). "Block" (available, with a reason from a list in a panel) and "Put back in use" (blocked) use the wards API (`ward:manage`; the API also wants `ward:read`). A move the status does not allow is disabled in the UI (`allowedActions`), the server's 409 is the authority: `conflict`, `invalid_transition`, `bed_not_available` and `bed_not_blocked` all read "Someone else changed this bed first", and the board is read again after every attempt.
- **The ward filter** lists wards through `GET /wards` (limit 100) and is left out without `ward:read`. A hospital with more than 100 wards would need a search there.
- **Not here yet:** admitting, transferring and discharging patients (the API exists, no screen), a ward map drawn as rooms and beds (the board is a list), counts per status, bed reservations. Occupied beds link nowhere yet.

## Decisions

- The board never keeps a patient in the query cache beyond the list itself; no cache entry is written by an action, which asks for the board again.
- Blocking uses the wards endpoints directly from this module's `api.ts`, not the `wards` module's internals; the reason list is repeated here (`BLOCK_REASONS`) and must follow the API's.
- The mock (`mocks/handlers/admissions.ts`) reads the beds from the wards mock (`mockBoardBeds`, `housekeepMockBed`), so one set of beds serves both screens, and every change of a bed there publishes on the mock stream. Only the sample hospital has `admissions` on.
