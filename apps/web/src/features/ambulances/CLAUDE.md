# Ambulances (web): module notes

What was decided for OP-03 (#197). The root `CLAUDE.md` wins where the two disagree. The API is `apps/api/src/features/operations/` (ambulance part); read its `CLAUDE.md` too.

- **One route, one nav entry** ("Ambulances", `ambulance:read`, `/ambulances`) behind the `ambulance` switch. Two sections on the page: **Trips** (status filter, newest-first as the server orders) and the **Fleet**. Both are cursor-paged `DataGrid`s, refreshed every 15 seconds. Works at every width.
- **Permissions:** `ambulance:dispatch` requests a trip and moves it (dispatch, patient picked up, complete, cancel); `ambulance:manage` adds an ambulance and takes it out of service or back. Buttons and row actions use `requires`, so they are absent without the permission.
- **Dispatch** opens a dialog listing the available ambulances (first 100, `useAvailableAmbulances`). A trip moving frees or takes an ambulance, so every mutation invalidates both lists. The server owns the rules (409 `ambulance_unavailable`, `invalid_transition`, `conflict`): the UI only disables moves the table does not allow and says "someone else changed this first".
- **Patient is optional** on a trip (an emergency has no record). Only the id is sent; `PatientSearch` chooses one, and the grid names the patient through `usePatientName` (a plain "Patient on record" without `patient:read`).
- **Out of service** is one toggle action; it is disabled for an ambulance on a trip (server: only from `available`).
- **Idempotency:** creates and moves send one key per identical body (`useAttempt`), so a second tap after a slow answer is the same request.
- **Mock:** `mocks/handlers/ambulances.ts` seeds two ambulances and one requested trip for the hospital; the clinic has the switch off.
- **Charging a trip (#589):** when a patient is chosen the request dialog offers their open visits (`useEncounters` from clinical; needs `encounter:read` and the clinical switch, else the choice is not shown) and a service (`ServiceSearch`, any category). Both are optional and sent as ids; the server refuses a visit that is not the patient's and an archived service. Billing posts the charge at the list price when the trip is completed. The grid's Charge column says the service and that it is billed on completion (or to the visit once completed); it does not read the charge itself. The service and visit cannot be added after the request.
- **Not built:** drivers and crew (no API: the vehicles are listed, drivers need a crew table), mileage, GPS, an ambulance's own trip history.
