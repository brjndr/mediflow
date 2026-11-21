# Audit log (web)

The hospital's own audit log screen (#1066). The API is `apps/api/src/features/audit/CLAUDE.md`; read it first. The root rules apply.

## What exists

- **One screen,** `audit-log`, behind the `audit_log` switch and `auditLog:read`, for phone, tablet and desktop (not desktop-only: an admin may check it on a tablet). A filter form (first and last day, at most 92 days, the person, kind of record, record id and action), then a `DataGrid` of entries newest first, 50 a page, loaded on "Load more". The form is checked on its own side (`filterSchema`) so a range past 92 days is never asked for.
- **The person filter** is a select of the hospital's staff through `useStaffOptions` (the `staff` feature's export, in `lib/bridge.ts`); it is left out for someone without `staff:read`, and the page works without it.
- **Export** (`auditLog:export`, `<Can>`): "Export these days (CSV)" asks for a stored `audit_log` run for the days now applied, follows it (1, 2, 4, 8 seconds, then every 15, not while the tab is hidden), says in an always-present `role="status"` line when it is ready, and "Download CSV" asks for the signed link only when pressed and uses `startDownload` from `features/reports` at once. The export covers the days, not the other filters.
- **Nothing is kept:** the search and the run are read with `gcTime: 0`, and a filter is in the body of a POST, never an address. Entries name record ids and an account's name, never a patient.
- **Strings** are in `locales/en.json` and `hi.json`; a test compares their keys. The module name for the platform's switch list is `platform.modules.audit_log` in the core common files.
- The mock (`mocks/handlers/audit.ts`) has 60 entries for the sample hospital (so paging shows) and one for the clinic, whose switch is off until a test turns it on.

## Known gaps

- No link from an entry to its record (a record id is shown as text), and no free-text search.
- The export does not apply the person, record or action filters.
- Not in `feature-locales.test.ts` (its own test compares the two files).
