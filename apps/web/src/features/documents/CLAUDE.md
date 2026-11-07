# Documents (web): module notes

What was decided for the patient document store's screen (MR-01, #189). The API is `apps/api/src/features/documents` (BE-29, #194); read its `CLAUDE.md` too. The root `CLAUDE.md` wins where the two disagree.

- **A tab, nothing else.** `DocumentsTab` is contributed to `patient.detail.tabs` (`document:read`, behind the `documents` switch). No route, no navigation item. It shows the patient's documents newest first, a page at a time, with a category filter and "Show retired documents" (both sent to the server).
- **Upload is two steps, as the API has them:** `POST /patients/{id}/documents` (idempotency key kept per identical body) answers a signed `uploadUrl`; `sendFile` then PUTs the bytes to it after the API base (`/api` + the address), with no session. Type (JPEG, PNG, PDF) and size (25 MB) are checked in the form first, the API checks again plus the first bytes. A file is `scanning` until the malware scan job clears it: the row says so and "Open" stays inert (`aria-disabled`) until it is `clean`.
- **Opening a file** asks `GET /documents/{id}/download-url` (audited by the API as an `export`; every listing is audited as `read`) and opens the signed link in a new window. The link is never stored or shown.
- **Retire, never delete:** a reason and the version read (`document:retire`). A retired document stays and can still be opened.
- **Categories are the "types"**; the API has no free tags. A tag field would need a contract change.
- **Mock:** `mocks/handlers/documents.ts` (three documents on `pth_00001`, `finishMockScan`, `mockDocumentAudit`). Not built here: consents and certificates as their own records (MR-02), the retention rules screen (the API has `documentRetention:*`), attaching a document to an encounter from the consultation, patient merge (#191).
