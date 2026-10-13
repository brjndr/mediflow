# Doctors: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Doctors (web and API):** the list with search and a department filter, a profile for a staff member (department, specialization, registration number, appointment length), inactive and active again, and regular weekly working hours with several sessions a day, behind the `doctors` switch and the `doctor:read` and `doctor:manage` permissions (#58, and the API in #61). It chooses the department through `useDepartmentOptions` from `@/features/departments`, so a hospital with doctors on needs departments on. Leave and one-off changes to hours belong with appointments.
