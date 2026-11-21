# Audit log (web)

The hospital's own audit log screen (#1066). The API is `apps/api/src/features/audit/CLAUDE.md`; read it first. The root rules apply.

## What exists

- **One screen,** `audit-log`, behind the `audit_log` switch and `auditLog:read`, for phone, tablet and desktop (not desktop-only: an admin may check it on a tablet). A filter form (first and last day, at most 92 days, the person, kind of record, record id and action), then a `DataGrid` of entries newest first, 50 a page, loaded on "Load more". The form is checked on its own side (`filterSchema`) so a range past 92 days is never asked for.
- **The person filter** is a select of the hospital's staff through `useStaffOptions` (the `staff` feature's export, in `lib/bridge.ts`); it is left out for someone without `staff:read`, and the page works without it.
- **Export** (`auditLog:export`, `<Can>`): "Export these days (CSV)" asks for a stored `audit_log` run for the days now applied, follows it (1, 2, 4, 8 seconds, then every 15, not while the tab is hidden), says in an always-present `role="status"` line when it is ready, and "Download CSV" asks for the signed link only when pressed and uses `startDownload` from `features/reports` at once. The export applies the person, record and action filters too, and an "Earlier exports" list (for `report:read`, audit runs only; the Reports screen leaves them out) names the filters each run had (#1107).
- **Nothing is kept:** the search and the run are read with `gcTime: 0`, and a filter is in the body of a POST, never an address. Entries name record ids and an account's name, never a patient.
- **Strings** are in `locales/en.json` and `hi.json`; a test compares their keys. The module name for the platform's switch list is `platform.modules.audit_log` in the core common files.
- The mock (`mocks/handlers/audit.ts`) has 60 entries for the sample hospital (so paging shows) and one for the clinic, whose switch is off until a test turns it on.

## Known gaps

- Free text (#1101): a "Search the action and kind of record" box, sent as `q` in the POST body only. The export does not take it (it keeps the four exact filters), and the screen says so while a text is applied.
- Record links (#1101): `lib/record-link.ts`. An id is a link only when the entity names a kind some feature makes linkable (`links` in its manifest; entity `patient` today) and the caller's policy allows the linked route (`requires` and flag); otherwise it stays text. The address is the manifest's own, never carrying a hospital. Other kinds (`invoice`, `encounter`...) become links by adding `links` to their feature, with no change here.
- Not in `feature-locales.test.ts` (its own test compares the two files).
