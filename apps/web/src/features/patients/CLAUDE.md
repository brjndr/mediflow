# Patients: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Patients (web and API):** the list with server-side search, sort and cursor paging; registration with a duplicate check while typing and on saving; the patient screen, which hosts the `patient.detail.tabs` and `patient.detail.actions` slots; editing with optimistic save and conflict detection; a field-level permission for contact details (`patient.contact:read`); deep links to a patient; audit of every read and write, and the `patient.registered` and `patient.updated` events. Exports `PatientSearch` (#71), the box another feature's screen chooses a patient with (booking an appointment): the term goes in the body of `POST /patients/search`, nothing is asked for until something is typed, and an option shows the name, the MRN and the date of birth, to tell two patients of one name apart. It needs `patient:read` and the `patients` switch, and says so without them.

## Decided

- **Patients can be registered from a file (#68),** through the import centre (`features/imports`), with `patient:import` (the admin's alone by default) as well as `patient:create`. Each is given an MRN, audited and announced as a registration at the desk is (`features/patients/create.ts` in the API, which `POST /patients` uses too). A row with the name and date of birth of someone registered is refused, not registered twice; a shared phone number is not a refusal there, since families share phones. Contact consent is never taken from a file: it is asked at the next visit. While a batch is written, a registration at the desk waits three seconds for the MRN counter and is then answered 503 `busy`.

## Known gaps

- Patient search finds a name by its exact letters, in any word order. It does not find a misspelled name; that needs the search design in #259.
- Patient search matches text against the hospital's rows without a trigram index, because row-level security keeps Postgres from using one (see `apps/api/CLAUDE.md`). It is fast at tens of thousands of patients per hospital; a very large hospital needs a dedicated search design.
