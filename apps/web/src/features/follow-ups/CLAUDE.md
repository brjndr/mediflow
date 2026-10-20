# Follow-ups: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Follow-ups (#88; the API is the clinical module's, notes in `apps/api/src/features/clinical/CLAUDE.md`):** when a patient should come back after a consultation, to whom, and the appointment it was booked as. Behind the `clinical` switch (the API's), `followUp:read` and `followUp:create`; booking also needs `appointment:create` and the `appointments` switch. Works at every width.

**On the consultation:** `FollowUpPanel`, exported from `index.ts` and rendered by the clinical module's consultation with the encounter's id and whether it is open or cancelled (ids and values, never the record). It shows the follow-up that is not cancelled ("Come back on 27 Oct to Dr Rao", its state in words with an icon, the note, who set it), the cancelled ones below it, and for `followUp:create` while the encounter is open "Set a follow-up": a day (with "In 7, 14 or 30 days" as a start), the doctor (the consultation's when none is chosen) and a message for the desk. A due one is cancelled with a reason (`followUp:create`) and booked in place (`appointment:create` with the appointments switch on).

**The due list:** `follow-ups`, behind `followUp:read`, in the navigation. A `DataGrid` of the follow-ups the caller may see, the soonest due first, those still to book by default, filtered by doctor (opening on the signed-in doctor's own, as the consultations list does), state and the last day due. The patient's name and the MRN masked, the day due, the doctor, the state ("To book, overdue" when the day has passed at the hospital) and the note. "Book" is a row action for `appointment:create` with the appointments switch on; "Open consultation" for `encounter:read`.

**Booking (`BookFollowUp`):** the follow-up's doctor or another one, a day of the booking window (the due day when it is in it, else the nearest end of the window), and one of the doctor's free times through `SlotPicker` from `@/features/appointments`. `POST /follow-ups/{id}/book` makes the appointment and links it in one transaction; a refused time offers the next free ones, as booking does.

## Decided

- **A folder of its own, on the clinical module's API (#88).** The front desk books follow-ups and reads no consultations (no `encounter:read`), so the due list needs a navigation entry of its own, and a manifest has one. A second manifest is a feature folder: no core change (the registry's `nav` stays one item). The id is `follow_ups` and the switch is `clinical`, the API's.
- **A follow-up is a day, not an appointment.** The doctor says when (and to whom); the desk books it, usually later, when the patient calls or comes. Booking it makes the appointment, which the follow-up then names: the acceptance criterion's "linked appointment". The doctor's default grants have no `appointment:create`, so a doctor sets it and the desk books it; an admin does both.
- **Its state is read from its appointment, never stored:** `due` with none, or one cancelled or missed (so it is to book again), `booked` with one scheduled, `attended` with one completed, `cancelled` when the follow-up itself was. Nothing has to follow the appointment's changes.
- **One follow-up per consultation that is not cancelled.** To change the day, cancel it (with a reason) and set another; a booked one is changed by moving or cancelling its appointment. A cancelled one stays, listed under the current one.
- **The day is a calendar day at the hospital,** from today to a year ahead (`DUE_DAYS_AHEAD`, the API's 366), checked on the form as typed days pass the date input's limits. Booking takes the appointments' window (today to 90 days).
- **Every POST carries an idempotency key,** one per body, and sends the `version` shown; a conflict or a state that changed meanwhile is said in words. Booked or refused, the follow-ups and the appointments (lists, calendar, free times, `useAppointmentsChanged`) are read again, and nothing is written once the session ended or moved hospital.
- **The due list is a `GET`:** ids, days and a state, nothing typed about a patient. It names patients, as `followUp:read` says, and the API audits every row read.
- **The due list books from the row as the list has it now,** not as it was when the panel opened: after a conflict the list reads it again and the next press sends the newer version. One booked or cancelled meanwhile closes the panel, and the status line says so. A due day past the 90 days that appointments are booked ahead is said, and the last day that can be booked is offered.
- **The note is for the desk:** the receptionist reads it, so the form asks for what to bring or arrange, with no clinical detail.
- **The booking panel's heading is one level below its part of the page:** `h2` on the due list, `h3` in the consultation.

## Mock

`mocks/handlers/clinical.ts`: `fu_h_1`, a due follow-up of `pth_00002` with `doc_h_02` from the closed visit `enc_h_2`, due tomorrow, "With the haemoglobin result"; `enc_h_1` has none. The API's rules: one per encounter, the window, versions, idempotency keys, booking through the appointments mock (`bookMockAppointment`, the same checks as `POST /appointments`), the state from the appointment. Tests read them with `mockFollowUps`. The clinic's receptionist holds `followUp:read`.

## Known gaps

- No reminders: nothing contacts a patient in v1 (the reminders module will read the due list's data through events).
- A follow-up stays booked after the visit until its appointment is completed: closing the encounter does not complete the appointment yet (a clinical gap).
- `own` scope is the consultations the doctor attends, not the follow-ups set to them (the API's notes).
- No way to see a patient's follow-ups on their own screen, and the doctor filter offers up to 100 practising doctors (`useDoctorOptions`).
