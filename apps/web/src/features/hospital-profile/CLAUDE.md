# Hospital profile: module notes

The root `CLAUDE.md` wins where the two disagree. API notes: `apps/api/src/features/hospital-profile/CLAUDE.md`.

## What exists

`/hospital-profile` (#696): a form for the address, phone, registration number and GSTIN printed by `Letterhead`. `hospitalProfile:read` shows it, `hospitalProfile:manage` allows saving (read-only fieldset otherwise).

## Decided

- **Offered under the `staff` switch.** The manifest needs a flag and the API has none for this; `staff` is on for every hospital that has an admin. A switch of its own would need the platform modules screen to list it.
- **Conflicts follow CLAUDE.md, Conventions:** only changed fields are sent with `expectedVersion`; on a 409 the profile is read again, typed values stay, other fields take the saved value, and a field both changed shows the saved value in a status box.
- **A saved change refreshes the session query** (the letterhead reads the tenant from it), so the next print shows it.
- Not on the desktop-only list: a single column form works on a phone.
