---
name: new-feature
description: Scaffold a new feature module (manifest, permissions, feature flag, routes, slots, settings, MSW handlers, tests). Use when adding any new feature or screen group to the HMS app.
---

# New feature module

Follow "Adding a new feature later" in CLAUDE.md. Do not edit core modules or other features. Core changes must be additive.

## Steps

1. **Plan first.** State the feature id, its permissions (`resource:action`), its feature flag, which slots it contributes to, and which domain events it consumes or emits. Wait for confirmation if anything is unclear.
2. **Create `apps/web/src/features/<name>/`** (and the matching Fastify plugin in `apps/api/src/features/<name>/` when the backend issue is in scope) with: `manifest.ts`, `api.ts`, `schemas.ts` (Zod), `types.ts`, `hooks/`, `components/`, `routes/`, `index.ts`.
3. **Manifest** (`FeatureManifest`): `id`, `titleKey`, `featureFlag`, `routes` (lazy-loaded, each with `requires`), `nav`, `permissions`, `extensions` (slot contributions), `settings` (Zod schema + permission) if the hospital admin can configure it.
4. **Data layer:** types include `tenantId`. API functions use the generated client. React Query hooks use tenant-scoped key factories only.
5. **UI:** every view handles loading, empty, and error states. Forms use React Hook Form + Zod. All strings go through i18n keys. Gate every action with `usePermission` or `<Can>`. Never compare role names.
6. **Register** the feature in the registry (one line). Default the flag to off.
7. **MSW handlers** for every endpoint under `apps/web/src/mocks/`.
8. **Tests:** happy path, validation errors, permission absent, flag off, two tenants (cache isolation), and idempotent behavior for event-driven parts.
9. **Verify:** `pnpm lint && pnpm typecheck && pnpm test`. Report bundle impact with `pnpm analyze`. Stay within the Performance Strategy budgets and follow the dependency policy.

## Do not

- Import another feature's internals (use its `index.ts`).
- Add dependencies without stating why and checking bundle impact.
- Hardcode hospital names, currencies, locales, or timezones.
