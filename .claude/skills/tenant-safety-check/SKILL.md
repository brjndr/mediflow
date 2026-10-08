---
name: tenant-safety-check
description: Audit code changes for multi-tenant isolation and access-control mistakes. Use before finishing any change that touches data fetching, caching, query keys, permissions, routing, or session handling.
---

# Tenant safety check

Review the current diff (`git diff`) against this checklist and report findings by file and line.

## Checklist

1. Every React Query key includes `tenantId` and is built by a key factory. No ad-hoc string keys.
2. On tenant switch and logout the cache is cleared, any global stores reset, and in-flight requests aborted.
3. The tenant is never derived from the URL, localStorage, or a client-supplied value for authorization. `X-Tenant-ID` is only a consistency check against the session.
4. New entity types and API payloads carry `tenantId`.
5. No role-name comparisons (`role === 'doctor'`). Access uses `usePermission`, `<Can>`, or manifest `requires`.
6. Every new route has `requires` permissions and a feature flag in its manifest, and is lazy-loaded.
7. Nothing hardcodes hospital names, currency, locale, timezone, or feature availability.
8. No data shared across tenants in module-level variables, singletons, or persistent browser storage.
9. Tests cover two tenants and permission-absent cases.

## Output

List each violation with file, line, why it is a risk, and the fix. If none, say which checklist items were verified. Do not modify code unless asked.
