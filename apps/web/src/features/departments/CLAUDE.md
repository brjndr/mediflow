# Departments: module notes

What this module is and what was decided for it. The root `CLAUDE.md` holds the rules every module follows, and it wins where the two disagree. Keep this file current with the module.

## What exists

**Departments (web and API):** the list, adding, editing with a version check, archiving and restoring, behind the `departments` switch and the `department:read` and `department:manage` permissions (#57, and the API in #61).

## Decided

- **Text is plain and tidied (#306).** The API stores a name in one normal form with single spaces, so two names that look the same are one department, and refuses a control character and anything that prints as nothing (#322); a description keeps its lines. The form checks the same patterns (`PLAIN_TEXT`, `PLAIN_LINES` of `shared/utils/text.ts`) and gives a pasted invisible character a message of its own. Rows written before this are left as they are and tidied when next changed: see `apps/api/src/core/http/CLAUDE.md`.
