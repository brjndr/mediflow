# Appointments: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Appointments (web, against the mock):** the list (#70): the appointments of a range of days at the hospital (today by default, at most 31 days), filtered by doctor and by status, a page at a time from the server, with the patient's name, the MRN masked, the doctor, the department and the status. A row opens its patient's screen, by id, for someone who may read patients. Behind the `appointments` switch and `appointment:read`; `appointment:create` and `appointment:update` are declared for booking (#71) and the changes of status (#73). Works at every width: the list becomes cards on a phone. Hosts the `appointment.row.badges` slot, given `context.appointmentId` only, in the status column, which cannot be hidden. A badge contribution is rendered once for every row, so it reads no data of its own: a query per row would be up to 100 requests, and as many audit entries, for one page. A feature that wants a badge needs the data for a whole page in one request first, as the `patient.detail.tabs` rule in the root `CLAUDE.md` keeps queries out of the contributed component. The calendar is #72. `GET /appointments` is in `packages/contract/planned.openapi.json` until the API (#75).

## Decided

- **A doctor reads the whole hospital's appointments, and the list opens on their own (#70).** The default grant of `appointment:read` to doctors has no `own` scope: a doctor covers for a colleague, and sees who is waiting for whom. The list opens filtered to the signed-in doctor, found as the doctor profile whose `userId` is theirs (`useDoctorOptions` from `@/features/doctors`), and choosing "All doctors" is kept until the screen is left. Someone with no profile at the hospital opens on every doctor. It is a default of the screen, not a limit: a hospital that wants doctors to see only their own gives the role `appointment:read` with scope `own`, which the API (#75) applies to the data.
- **The list is a `GET`, with days, a doctor's id and a status in its address** (#70). Nothing in it is typed about a patient, so it is not a search (Searches in the root `CLAUDE.md`). Its answer names patients, so the API audits every page read (#75).
- **A row names its patient to anyone who may read appointments,** by name and MRN, without `patient:read`: an appointment means nothing without whom it is for. Opening the patient's screen still needs `patient:read` and the `patients` switch.
- **Days are calendar days at the hospital,** sent as `YYYY-MM-DD`; the server turns them into instants in the hospital's timezone. Today is today at the hospital (`todayIn`), not in the browser. The range is checked on the screen before anything is asked for.
- **The doctor filter offers up to 100 practising doctors** (`useDoctorOptions`). A hospital with more needs a search in its place. Without the `doctors` switch or `doctor:read` the filter is not offered.
- **The days are set when the screen opens.** Left open past midnight at the hospital, it still shows the day it opened on; "Today" brings it back.
- **No reason in a list row.** The reason for a visit is the record's, read when the appointment is opened (#71).

## Mock

`mocks/handlers/appointments.ts` seeds appointments around today at each hospital, deterministic for a given day: six doctors with eight fifteen-minute appointments each morning at the hospital, two doctors with three each at the clinic, from three days ago to a week ahead. It keeps ids only and looks up names when it answers, as the API will join them.
