# Clinical: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**The OPD consultation (web; the API is #86, notes in `apps/api/src/features/clinical/CLAUDE.md`):** the encounter, its notes and its diagnoses (#80). Behind the `clinical` switch and `encounter:read`, `encounter:create`, `encounter:update`, `clinicalNote:read`, `clinicalNote:write`, `diagnosis:read` and `diagnosis:write`. Works at every width. Orders and prescriptions (#81, #82, #87), the patient's timeline (#83) and the printable summary (#89) are still to come.

**Starting (#80):** "Start consultation" on the token being served on the queue board (`queue.row.actions`) and on today's scheduled appointment, in the list and on its screen (`appointment.row.actions`, `appointment.detail.actions`), for `encounter:create` and `encounter:read`, and `patient:read`, which the component checks. One press opens the encounter (`POST /encounters` with the token or the appointment) and goes to it.

**The consultation (#80):** `encounters/:encounterId`, behind `encounter:read`. Who the visit is for (name and MRN, which `encounter:read` gives), with whom, its status, then `TriageSummary` from `@/features/triage` (allergies and the newest vitals; before the notes on a narrow screen, beside them from 1024 px), the notes for `clinicalNote:read`, the diagnoses for `diagnosis:read`, and closing or cancelling for `encounter:update`.

**Consultations (#80):** `encounters`, behind `encounter:read`, in the navigation. A `DataGrid` of the encounters the caller may see, open ones by default, opening on the signed-in doctor's own (found by `userId` in `useDoctorOptions`, as the queue board does); filtered by doctor and status. It brings a doctor back to a visit left open, since a served token leaves the board.

## Decided

- **Opening is a press, not a visit to a page.** The action sends the token or the appointment and the patient, with an idempotency key, and goes to the encounter the server answers with: the one opened now, or the one already open for that token or appointment (200). Pressing it again from a second desk finds the same encounter. Nothing in the address but the encounter's id.
- **Offered on the token being served only** (`called`): the doctor starts the consultation with the patient in the room; a waiting patient may still be skipped. On an appointment, only a scheduled one that starts today at the hospital, as check-in.
- **The appointment slots are given `patientId` (#80),** an additive change to the slot contexts (`docs/EXTENDING.md`), since opening needs the patient with the appointment and a contribution reads no data of its own.
- **Notes and diagnoses are each behind their own permission, and a role without one sees no trace of it:** no heading, no empty state, no request. A role with `encounter:read` alone (the nurse's default) sees the visit and what triage found, not what it was for (the field-level restriction of the issue; #84 checks the whole matrix).
- **A draft is kept on the server as it is written, never in the browser** (`useDraftNote`). The first save creates it (`POST`, with an idempotency key per body), later ones save it whole from the version it was read at (`PATCH`). It is saved 1.5 seconds after typing stops, when focus leaves the editor (not when it moves to the toolbar), before signing, and when the editor goes away. What is typed waits in memory only, and nothing is sent once the session ended or moved hospital. An empty document is never sent. One save at a time; typing during a save is saved after it. `localStorage` and `sessionStorage` stay empty, which the unit test and the Playwright test check.
- **A draft is not refreshed from the list while it is written.** Saving does not re-read the notes, so the editor never loses what is being typed. A draft started here keeps its place under a key of its own until the server gives it an id, and the list's copy of it is not drawn twice.
- **The save state is plain text under the editor, described by it, not a live region:** it changes at every pause in typing, and a screen reader would hear it all the time. A failed save and a conflict are alerts; signing, discarding and amending are said in the panel's status line, which takes focus when what had it went away.
- **A conflict pauses saving and asks.** A `409 conflict` on a draft means its author saved it from another window. The screen keeps what is typed and offers "Keep the text here" (saved over the newer version) or "Use the saved text" (the editor shows that one). Nothing is overwritten without the choice.
- **Discarding asks once**, in place: the question takes the button's place with focus on "Keep it", the safe answer.
- **Signed notes are shown oldest first, with their amendments.** An amended note says it was amended and is shown muted; the amendment says which note it amends and why. "Amend" is offered on a signed note not yet amended (a later correction amends the amendment), with the whole text to correct and a reason, for `clinicalNote:write`, also after the encounter closed but not once cancelled.
- **Diagnoses are a `DataGrid`:** the code and title as recorded and/or the words, provisional or final, who recorded it, and whether it stands. A retracted one stays, struck through and said in words ("Retracted … : reason"), never by the line alone. Recording takes `CodeSearch` from `@/features/codes` (ICD-10), words, or both (neither is refused on the form as on the server), while the encounter is open. "Retract" is a row action with a reason, also after the encounter closed.
- **Closing and cancelling are the server's to refuse.** Closing with a draft is `409 unsigned_notes` ("Sign or discard every draft first"); cancelling once anything is recorded is `409 has_records` ("close it instead"). Both send the version shown; a conflict re-reads the encounter. The buttons go once it is closed or cancelled, and focus goes to the status line.
- **Every POST carries an idempotency key,** one per body, cleared after an answer, as the API requires. An answer is written to the cache only for the session it was asked in (`useStillHere`, as triage does).
- **The consultations list is a `GET`** with a doctor's id and a status: nothing typed in it says anything about a patient. `total` comes only with a doctor chosen, as the API counts.
- **Triage's reading list takes two columns by its container's width (#80),** not the window's (`@container` in `features/triage/components/reading.tsx`), so the summary fits the side column, text at 200% included.

## Mock

`mocks/handlers/clinical.ts` keeps encounters, notes and diagnoses per hospital: at the hospital, an open consultation `enc_h_1` of `pth_00001` with `doc_h_01` (a signed note and a provisional J06.9) and a closed one `enc_h_2` of `pth_00002`; at the clinic, an open `enc_c_1` of `ptc_00001`. It follows the API's rules and codes: tokens of today (`mockQueueToken`), appointments (`mockAppointment`), one encounter per token or appointment, the doctor from the token, the appointment or the caller's own profile (`mockDoctorOfUser`), scopes `all` and `own`, drafts only their author sees, versions, idempotency keys per hospital and user, closing and cancelling refusals, amended once, retracted once, ICD-10 codes (`mockCode`). Tests read it with `mockEncounter` and `mockNotesOf`, and save a draft behind the screen with `editMockNote`. The mock's admin and doctor hold every clinical permission.

## Known gaps

- Walk-ins without a token are not started from the patient's screen: the API takes a walk-in, the web does not offer it yet.
- Orders, prescriptions, results and the timeline are #81 to #83 and #87; closing does not complete the appointment yet (an appointments subscriber of `encounter.closed`).
- Against the real API, `db:seed` opens no encounter: one is started from a token the doctor calls.
- The doctor filter offers up to 100 practising doctors, as `useDoctorOptions` does.
