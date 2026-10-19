# Triage: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Triage (web, against the mock; the API is #79):** a nurse records a patient's vitals (blood pressure, pulse, temperature, oxygen saturation, weight, height), the chief complaint and the allergies before the consultation (#77). Behind the `triage` switch and `vitals:read`, `vitals:record`, `allergy:read` and `allergy:update`. Works at every width.

**Recording (#77):** `triage/:patientId`, behind `vitals:record` and `vitals:read`, opened from a token of the queue board (`?token=<id>`, through the `queue.row.actions` slot, on tokens waiting or being served) and from the patient's tab. It shows who the patient is (name and MRN, for `patient:read`), the allergies, whether vitals were already taken for that token, and the form. A value outside the hospital's range is marked "High" or "Low" beside its field as it is typed, BMI is shown from the weight and height, and the screen confirms in place with the reading and how many values are out of range. `?corrects=<id>` starts a correction from that reading.

**The patient's tab (#77):** "Vitals and allergies" in `patient.detail.tabs`: the allergies (edited in place, for `allergy:update`) and the readings, newest first, a `DataGrid` page at a time with the out-of-range values marked, corrections and the readings they correct labelled, and "Correct" on a reading for `vitals:record`. A role with only one of `vitals:read` and `allergy:read` sees that part.

**`TriageSummary`** (from `index.ts`): the allergies and the newest reading of a patient, for the consultation view (#80). Renders nothing with the switch off, and each part only for its permission.

## Decided

- **A reading belongs to the patient, and to the queue token it was taken for.** No encounter exists before M7, and triage does not invent a visit: `queueTokenId` says which token, and `encounterId` is filled in once the clinical module opens the OPD encounter from `queue.called` (#80), which links the token's readings to it. A reading taken outside the queue (from the patient's tab) has no token.
- **Readings are append-only.** A correction is a new reading with `correctsId` and a reason (`correctionReason`, required); the original stays, marked "Corrected" in the history. A second reading for the same token is allowed (a re-check) and said on the form, not refused. `vitals.recorded` is emitted for each (#79).
- **Fixed units, stored as numbers:** mmHg, beats a minute, °C and kg to one decimal, %, cm. The API refuses what a body cannot be (systolic 40 to 300, diastolic 20 to 200 and below the systolic, pulse 20 to 300, temperature 25 to 45, SpO₂ 50 to 100, weight 0.3 to 400, height 20 to 250); the form checks the same. Typed with a point: "37,5" is refused, not read as 375. A hospital that measures in °F or lb needs a setting, an additive change.
- **BMI is shown, never stored or sent,** and never marked high or low.
- **The ranges are the server's, per hospital and per patient (#77).** `GET /patients/{id}/vital-ranges` gives the hospital's ranges that apply to that patient, or `null`. The screen marks values against them and never decides itself who they apply to. Until #379 they are for adults only: the server returns `null` for a patient under 18 at the hospital's date, and the screen says that nothing is marked for a patient under 18. Editing them is #378: until then they are seeded per hospital. A past reading is marked against today's ranges; no flag is stored.
- **A mark is a word with an icon** ("High", "Low", an arrow), never colour alone, red-100 on red-900 text for contrast.
- **Allergies are a list on the patient with three states:** `unknown` (never asked, version 0), `none` ("No known allergies", asked) and `listed`. "Not asked yet" and "No known allergies" are never shown alike: one is a question still to ask. Free-text substance, reaction and a severity from a fixed list (severe, moderate, mild, not known); coded allergens need a catalog, a later change. At most 50.
- **Allergies are replaced whole, from the version the edit started from.** Someone else's save first is 409 `conflict`: the form keeps what was typed, shows the list as saved now, and saving again replaces it from the newest version. Saving sends the whole list, not the changes: a list of a few short rows has no fields to merge.
- **Every reading carries an idempotency key,** one per body, as issuing a token: a double click or a retry records it once.
- **Nothing in an address but ids:** `triage/<patientId>?token=<id>` or `?corrects=<id>`, and the API's paths take the patient's id. The list of readings is a `GET`: nothing typed in it says anything about a patient.
- **The queue row shows a link, not whether vitals were taken.** A contribution to `queue.row.actions` is rendered for every row and reads no data of its own (a request per row would be up to 100 requests, and as many audit entries, per page). The form says when the token's vitals were already taken. A "vitals taken" mark on the board needs the queue's page to carry it, or one request for a page.
- **Permissions:** `vitals:read`, `vitals:record`, `allergy:read`, `allergy:update`. Default grants for the API's seed (#79) follow the "Triage and vitals" row of `docs/PRODUCT.md`: nurse records, doctor and admin view (admin all four for setting up). The mock has no nurse: its admin and doctor hold all four, so the screens can be tried.

## Mock

`mocks/handlers/triage.ts` keeps readings and allergies per hospital: at the hospital, two readings of `pth_00001` (the newer with a high blood pressure and pulse) and a severe penicillin allergy; at the clinic, one reading of `ptc_00001` (37.6 °C, above the clinic's limit of 37.5) and "No known allergies". Every other patient has no readings and allergies never asked. The ranges are seeded per hospital, and `null` for a patient under 18 (from `mockPatientDob`). It checks a token against the queue mock (`mockQueueToken`: this patient's, today), a correction against the patient's readings, versions and idempotency keys, and the limits of the API. Tests change allergies behind the screen with `editMockAllergies` and read what was recorded with `mockVitalsOf`.

## Known gaps

- The ranges cannot be edited (#378) and apply to adults only (#379).
- No "vitals taken" mark on the queue board (see Decided).
- No respiratory rate, pain score, blood glucose or head circumference: a field each, additive.
- Units are fixed (°C, kg, cm).
- The consultation view that shows `TriageSummary` is #80.
