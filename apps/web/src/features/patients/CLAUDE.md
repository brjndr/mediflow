# Patients: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Patients (web and API):** the list with server-side search, sort and cursor paging; registration with a duplicate check while typing and on saving; the patient screen, which hosts the `patient.detail.tabs` and `patient.detail.actions` slots; editing with optimistic save and conflict detection; a field-level permission for contact details (`patient.contact:read`); deep links to a patient; audit of every read and write, and the `patient.registered` and `patient.updated` events.

## Known gaps

- Patient search finds a name by its exact letters, in any word order. It does not find a misspelled name; that needs the search design in #259.
- Patient search matches text against the hospital's rows without a trigram index, because row-level security keeps Postgres from using one (see `apps/api/CLAUDE.md`). It is fast at tens of thousands of patients per hospital; a very large hospital needs a dedicated search design.
