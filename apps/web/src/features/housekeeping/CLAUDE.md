# Housekeeping (web): module notes

What was decided for this module in the web app (#198). The root `CLAUDE.md` wins where the two disagree. The API is in `apps/api/src/features/operations/CLAUDE.md` (cleaning tasks); the beds are the `wards` module and the bed board is `admissions`.

## What exists

**The task list** at `/housekeeping`, behind the `housekeeping` switch and `cleaningTask:read`. Cleaning tasks as a `DataGrid` (bed number names the row), from `GET /cleaning-tasks` one server page at a time (oldest first), filtered by one status (default Open). The server makes a `discharge` task when a bed is released (`bed.released`); this screen only works them.

- **Actions per row:** Start (open to in progress) and "Finish: bed ready" (in progress to done) need `cleaningTask:work`; "Cancel task" needs `cleaningTask:manage`. All use `POST /cleaning-tasks/{taskId}/move` with the task's `version` and an Idempotency-Key. Finishing makes the bed available on the server (it needs `wards` on, else 403 `feature_disabled`, shown as its own message). A move the status does not allow is disabled; `conflict` and `invalid_transition` read "Someone else changed this task first".
- **No live stream:** the list is read again every 15 s (the bed event stream needs `admission:read`, which a cleaner may not have). After a move the list is read again.
- **Not here yet:** asking for a routine cleaning (`POST /cleaning-tasks`, needs a bed picker), assigning a task to a person, a ward filter.

## Decisions

- Nothing here carries a patient: a task names a bed and a ward only.
- The mock (`mocks/handlers/housekeeping.ts`) seeds one open task for the cleaning bed GW-A-03 and finishing a task sets the bed available through `changeMockBed` of the admissions mock, so the bed board follows. Only the sample hospital has `housekeeping` on.
