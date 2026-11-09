# Nursing (web): module notes

What was decided for this module in the web app (#157, NR-01). The root `CLAUDE.md` wins where the two disagree. The API is `apps/api/src/features/nursing/CLAUDE.md` (#163); read it too.

## What exists

- **Worklist** at `/nursing` (`admission:read` and `nursingVitals:read`, `nursing` switch; the API also needs `admissions`): `GET /admissions?status=admitted` as a `DataGrid` (patient first, MRN masked), filtered by ward (`?ward=` in the address; the select is left out without `ward:read`). "Chart vitals" opens the stay.
- **Vitals chart** at `/nursing/:admissionId/vitals`: record a reading (`nursingVitals:record`; at least one measurement, systolic and diastolic together), correct one with a reason (a new reading; the corrected one stays in the table marked "Corrected" and is left out of the chart and the score), a trend chart (`TimeSeriesChart`, one measure at a time or the score), and the readings as a `DataGrid` with the API's low/high flags written as words. Only the newest 50 readings load first, more by "Load more"; the chart draws what is loaded. Writes are hidden for a stay that is not admitted.
- **Early warning score** (`ews.ts`): points from bands per measurement (systolic, pulse, temperature, SpO2: the NEWS2 bands as defaults), added up; `attention` at 5 or any one measurement at 3, `urgent` at 7. A level is a word and an icon. "Worsening" when the score rose by 2 or more since the reading before, or rose at each of the last three. Respiratory rate and consciousness are not charted, so it is a guide (the screen says so). Bands: min included, max excluded.

## Decisions and gaps

- **Configurable** means `EwsConfig` is a parameter of the scoring and `nursingSettingsSchema` (`settings.ts`) is declared in the manifest, but tenant settings are not delivered to the web app yet, so `useEwsConfig()` returns the defaults. When the settings reach the tenant config, read them there; nothing else changes.
- **No "per nurse" list:** the API has no assignment of patients to a nurse; the worklist is per ward. A proposed follow-up.
- The mock keeps readings in `mocks/handlers/nursing.ts`, registered before the admissions handlers because `/admissions/:id/:action` there would otherwise answer the POSTs. Tests admit patients with `addMockAdmission` (`mocks/handlers/admissions-flow.ts`) and chart readings with `addMockWardVital`.
- Idempotency keys come from `hooks/use-nursing.ts`, one per request body.
- Not built (API has them): the medication chart, progress notes, diet and ward stock requests.
