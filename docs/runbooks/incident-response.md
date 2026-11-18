# Incident response and support access

Written as policy. Steps that need the hosted environment (deploy, rollback, restore, log access) are marked **Waiting for #146** and are completed in #148. Until a hosted environment exists, this describes what to do and who decides.

## What counts as an incident

- **Security:** a suspected leak or wrong access to patient data, one hospital seeing another's data, a lost device or leaked credential or key, malware in an upload.
- **Availability:** the app is down or too slow for a hospital to work.
- **Data integrity:** wrong or missing records, a failed migration, a stock or billing figure that does not reconcile.

## Roles

- **Incident lead:** the first engineer to take it; they own it until handed over. One person at a time.
- **Communicator:** tells affected hospital admins. Can be the lead for a small incident.
- **Product owner:** decides on suspending a hospital, notifying authorities and wording to hospitals.

## Steps

1. **Declare:** open a GitHub issue labelled `P0` (or `P1`) with a time line. Keep patient facts, names and tokens out of it: use ids only.
2. **Contain first:** stop the harm before the cause is known. Options: suspend a hospital from `/platform` (staff lose access on the next request and sessions end), switch a module off for one hospital, revoke a user's sessions, rotate a leaked secret. Rolling back a release is **Waiting for #146**.
3. **Assess:** which hospitals, which data, from when to when. Use the hospital's audit log (reads and writes of patient data) and the platform trail. Tenant isolation or PHI exposure means treat as a breach until shown otherwise.
4. **Tell hospital admins** of every affected hospital promptly: what happened, what data, what is done, what they should do. A breach of personal data is reported to the authorities as the DPDP Act and the contract require; the product owner decides and files. Do not message patients: the product contacts none, and the hospital decides.
5. **Fix and verify:** a fix goes through the normal PR and CI, with a test that fails without it. Deploy is **Waiting for #146**.
6. **Close:** within five working days write a short review in the issue: time line, cause, what worked, what changes. Open follow-up issues for each change. No blame.

## Do not

- Copy production data to a laptop, a chat or an issue, even to debug.
- Put patient data, tokens or links with credentials in logs, issues or chat.
- Delete audit rows or edit history to tidy up. Corrections are new entries.

## Support access to a hospital's data

Platform admins have no access to patient data. If support needs to see a record:

1. Prefer a screen share led by the hospital's own staff, or a description of the problem with ids only.
2. If direct access is unavoidable it is **explicit, time-limited, approved by that hospital's admin and written to the audit log** (`docs/ARCHITECTURE.md`). The access method (break-glass) is designed but **not built**: until it is, no one gets such access, and the hospital admin is asked to act instead.
3. Record in the issue who asked, who approved, why, and when it ended.

## Contacts and tooling

Names, phone numbers, the pager and log, metric and alert tools are **Waiting for #146** and #149 (no hosted environment yet). Fill them in here when they exist.
