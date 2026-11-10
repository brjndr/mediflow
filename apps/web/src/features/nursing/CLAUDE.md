# Nursing (web): module notes

What was decided for this module in the web app (#157, NR-01). The root `CLAUDE.md` wins where the two disagree. The API is `apps/api/src/features/nursing/CLAUDE.md` (#163); read it too.

## What exists

- **Worklist** at `/nursing` (`admission:read` and `nursingVitals:read`, `nursing` switch; the API also needs `admissions`): `GET /admissions?status=admitted` as a `DataGrid` (patient first, MRN masked), filtered by ward (`?ward=` in the address; the select is left out without `ward:read`). "Chart vitals" opens the stay.
- **Vitals chart** at `/nursing/:admissionId/vitals`: record a reading (`nursingVitals:record`; at least one measurement, systolic and diastolic together), correct one with a reason (a new reading; the corrected one stays in the table marked "Corrected" and is left out of the chart and the score), a trend chart (`TimeSeriesChart`, one measure at a time or the score), and the readings as a `DataGrid` with the API's low/high flags written as words. Only the newest 50 readings load first, more by "Load more"; the chart draws what is loaded. Writes are hidden for a stay that is not admitted.
- **Early warning score** (`ews.ts`): points from bands per measurement (systolic, pulse, temperature, SpO2: the NEWS2 bands as defaults), added up; `attention` at 5 or any one measurement at 3, `urgent` at 7. A level is a word and an icon. "Worsening" when the score rose by 2 or more since the reading before, or rose at each of the last three. Respiratory rate and consciousness are not charted, so it is a guide (the screen says so). Bands: min included, max excluded.

## Decisions and gaps

- **Configurable** means `EwsConfig` is a parameter of the scoring and `nursingSettingsSchema` (`settings.ts`) is ready, but it is not in the manifest (a `settings` entry adds a section to the admin settings screen, which would show an empty one) and tenant settings are not delivered to the web app yet, so `useEwsConfig()` returns the defaults. When the settings reach the tenant config, read them there; nothing else changes.
- **No "per nurse" list:** the API has no assignment of patients to a nurse; the worklist is per ward. A proposed follow-up.
- The mock keeps readings in `mocks/handlers/nursing.ts`, registered before the admissions handlers because `/admissions/:id/:action` there would otherwise answer the POSTs. Tests admit patients with `addMockAdmission` (`mocks/handlers/admissions-flow.ts`) and chart readings with `addMockWardVital`.
- Idempotency keys come from `hooks/use-nursing.ts`, one per request body.
- Not built (API has them): progress notes, diet and ward stock requests.

## Medication chart (#158, NR-02)

- **Screen** `/nursing/:admissionId/mar` (`admission:read` and `mar:read`; charting needs `mar:record`), reached from "Medication chart" on the worklist. Doses due on a day (a date input, default today at the hospital) as a `DataGrid`, the entries on the chart below it (newest due first, "Load more"), the patient's allergies above.
- **The schedule is the web app's** (`mar-schedule.ts`): the API keeps no schedule, only an entry per order and `scheduledAt`, one per slot (409 `slot_recorded`). So the clock times a frequency is due are fixed in one table, in the hospital's timezone, the same for every device: `OD` 08:00, `BD` 08:00 and 20:00, `TDS` 06, 14, 22, `QID` 06, 12, 18, 22, `HS` 22:00, `1-0-1` by its number of parts, `q6h` every N hours from 06:00. An order with no times (as needed, `SOS`, anything not understood) is one row, "As needed", charted for the minute it is given. Making the times a hospital setting is a follow-up; until then a changed table would give different instants for the same dose, so change it with care. Slots before the order was placed are left out; the API refuses a slot more than 24 hours ahead, so those rows cannot be charted.
- **Dose checks** (`marFormSchema`): a given dose is typed, defaulting to the order's, and a dose that is not the ordered one needs a reason; anything but given needs a reason; amending always does. The server's rule on doses a day answers 422 `extra_dose_reason_required`, and the dialog then asks for the reason (the mock has the same rule).
- **Allergies:** read with triage's `useAllergies` (needs `allergy:read`; without it the screen says so and does not check) and matched to the medicine by clinical's `allergyCovers`. The match is by the order's `itemName`, as the order carries no generic name. A match shows an alert and the dose needs the nurse's confirmation. Charting is disabled until the allergies have loaded. It warns, never refuses.
- **Append-only:** nothing edits an entry. "Amend" adds a new entry for the same order and slot that names the one it amends, which stays in the list marked "Amended"; the amendment is marked "Amendment". An amended entry cannot be amended again (the API says 422).
- `not_dispensed` (nothing dispensed yet) is shown in the dialog before charting and in the status line after. It is a warning only.
- **Not built:** a witness for high-risk medicines, a patient or bedside barcode check, due and overdue doses on the worklist, a hospital-set schedule.
- The mock is `mocks/handlers/nursing-mar.ts` (`addMockMarOrder`, `addMockMarEntry`), spread first in `nursingHandlers`.
