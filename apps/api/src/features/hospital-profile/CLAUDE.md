# Hospital profile API

What was decided for the hospital's own letterhead details (#696). The screen is `apps/web/src/features/hospital-profile`.

- **`GET` and `PATCH /hospital-profile`** read and change `tenants.address`, `phone`, `registration_number` and `gstin` of the session's hospital. Permissions `hospitalProfile:read` and `hospitalProfile:manage`, admin by default. No module flag (like roles and staff): the printing modules have their own.
- **Migration 0093** gives the app role `UPDATE` on those four columns plus `version` and `updated_at`, and an RLS update policy on its own row. Everything else about a hospital (name, locale, status, limits, theme) stays with the platform role.
- **`tenants.version`** (from the platform module) is the one version: a platform edit and this one both move it. `PATCH` takes `expectedVersion`, locks the row (`for update`), answers 409 `conflict` on a mismatch, and writes nothing (no version bump, no audit) when nothing changed.
- **Text is tidied** as elsewhere (`tidyWithin`, `tidyLinesOptional`); an empty text removes a detail; the GSTIN is accepted in any case and stored in capitals (15 characters, first two digits).
- **Printing reads the session's tenant** (`toTenant`, which now has `gstin`), so a saved change shows on the next print after the web app refreshes its session.
- Audit: `update` on entity `hospital_profile`, entity id the hospital's id. No values are logged.
