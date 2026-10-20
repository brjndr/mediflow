# Doctors: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Doctors (web and API):** the list with search and a department filter, a profile for a staff member (department, specialization, registration number, registering council, qualifications, appointment length), inactive and active again, and regular weekly working hours with several sessions a day, behind the `doctors` switch and the `doctor:read` and `doctor:manage` permissions (#58, and the API in #61). It chooses the department through `useDepartmentOptions` from `@/features/departments`, so a hospital with doctors on needs departments on. Leave and one-off changes to hours belong with appointments. Exports `useDoctorOptions` (up to 100 practising doctors, each with the `userId` of its staff member and its `departmentId`), which the appointment list chooses a doctor with and finds the signed-in doctor's own profile by, and the queue (#76) narrows to a department's doctors with.

## Decided

- **The registration number, its council and the qualifications are what a printed prescription names (#397),** beside the name, as the NMC asks (`apps/web/src/features/clinical/CLAUDE.md`). Each is optional plain text (50, 100 and 200 characters), written as printed ("MBBS, MD (General Medicine)"): no list of degrees or councils, which differ by state and change. The profile says, with an icon and in words, when the qualifications or the registration number are missing, and that prescriptions print saying so; it never refuses. The council is not required.
