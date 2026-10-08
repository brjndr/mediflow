---
name: add-list-view
description: Build a list or table screen with server-side pagination, search, sorting, and tenant-scoped query keys. Use for any screen that lists records (patients, appointments, invoices, etc.).
---

# List view pattern

Never load all records. Never filter or sort large data on the client.

## Requirements

- **Server-side** cursor pagination, filtering, and sorting. The endpoint returns `{ items, nextCursor, total? }`.
- **Query keys** from a key factory and always including `tenantId`, e.g. `patientKeys.list(tenantId, filters)`.
- **React Query:** `placeholderData: keepPreviousData` while paging, a sensible `staleTime` for the data type, prefetch the next page, and cancel stale requests on filter change.
- **Search input:** debounce 300 ms. Reset the cursor when filters change.
- **Table:** the shared DataGrid (TanStack Table) with page sizes of 25 to 100, and TanStack Virtual for long pages (beyond about 100 rendered rows).
- **States:** loading skeleton, empty state, error state with retry.
- **Access:** route requires the `:read` permission. Row and bulk actions are wrapped in `<Can>`. Field-level permissions hide sensitive columns.
- **PHI:** mask phone/MRN where full values aren't needed. Never log row data. Do not put patient data in URLs (use IDs only).
- **i18n and formatting:** labels via i18n, dates and money via the tenant-aware formatters.

## Tests

Pagination moves forward and back, filter change resets the cursor, error and empty states render, permission-absent hides actions, and switching tenant does not show the previous tenant's rows.
