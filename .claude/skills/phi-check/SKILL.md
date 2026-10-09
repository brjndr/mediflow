---
name: phi-check
description: Check changes for patient data (PHI) exposure in logs, storage, URLs, error reports, analytics, and UI. Use before finishing any change that handles patient, clinical, or billing data.
---

# PHI check

Review the current diff (`git diff`) and report findings by file and line.

## Checklist

1. No PHI (names, phone, DOB, MRN, diagnoses, notes, invoice details) in `console.*`, error messages, Sentry events/breadcrumbs, analytics, or web-vitals tags.
2. No PHI in URLs, query strings, route params (IDs only), or page titles.
3. No PHI in `localStorage`, `sessionStorage`, IndexedDB, cookies, or service worker caches.
4. Sensitive fields are masked in lists where the full value isn't needed.
5. Field-level permissions are respected (e.g. diagnosis hidden from roles without `patient.diagnosis:read`).
6. No `dangerouslySetInnerHTML`. User input is sanitized before rendering.
7. Exports, downloads, and print views are permission-gated and audit-relevant actions go through the API so the backend can log them.
8. Test fixtures and MSW data are synthetic. No real patient data anywhere in the repo.
9. Error boundaries and error reporting scrub request/response bodies.

## Output

List each violation with file, line, risk, and the fix. If none, say which items were verified. Do not modify code unless asked.
