# Departments API

What was decided for this feature's API. Moved out of `apps/api/CLAUDE.md` (#370); Claude Code loads it when a file of this folder is read. The web side's notes are in `apps/web/src/features/departments/CLAUDE.md`.

- **`features/departments`** is reference data with no patient data: the pattern for a small catalog. It is behind the `departments` module flag, with `department:read` for the list and `department:manage` for every change.
- **A name is one department per hospital,** whatever its capitals, archived or not: a unique constraint on the stored lower-case name. The route checks first, to answer 409 `department_name_taken`, and the constraint settles two requests that arrive together.
- **Archived, never deleted.** The app role has no DELETE on the table. Archiving and restoring twice changes nothing and writes nothing.
- **The list is a GET with a cursor,** unlike the patient search: a department's name is not patient data. It is ordered on the stored lower-case name and the id, and the cursor holds those two values of the last row.
- **`(tenant_id, id)` is unique** so that another table refers to a department together with its hospital: `FOREIGN KEY (tenant_id, department_id) REFERENCES departments (tenant_id, id)`. A reference by id alone could name another hospital's department, because foreign keys are checked without row-level security. Do the same for any table other tables point at.
- **Changes are audited** through `request.audit('create' | 'update' | 'archive' | 'restore', 'department', id)`, although it is not patient data: who changed the hospital's structure is worth knowing.
- **`POST /departments` accepts an Idempotency-Key** and stores the whole answer for a replay, since it holds no patient data.
