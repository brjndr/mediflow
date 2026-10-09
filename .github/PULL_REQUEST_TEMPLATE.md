## Summary

<!-- What changed and why. One issue per PR. -->

Closes #

## Checks

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] Tests cover happy path, validation, permission absent, flag off, and two tenants where relevant
- [ ] `/tenant-safety-check` and `/phi-check` run on this diff (if data or access is touched)
- [ ] No PHI in logs, URLs, storage, fixtures, or screenshots
- [ ] CLAUDE.md or docs updated if a contract or convention changed

## Bundle size

<!-- CI posts the size of every chunk and the change against the base branch in the job summary. -->

- [ ] Budgets pass (`pnpm build && pnpm budget`)
- [ ] No chunk grew by more than 30 kB gzipped, or the reason is given here:

## New dependencies

<!-- Delete this section if the PR adds none. One line per package, each point answered. -->

- [ ] **Reason:** why this package, and why not a platform feature or something already installed
- [ ] **Size:** gzipped impact from `pnpm analyze`, and whether it is lazy-loaded or in the initial bundle
- [ ] **Licence:** MIT, Apache or BSD. Anything else, or any paid or premium plugin, is called out for approval
- [ ] **Maintenance:** recent releases, not deprecated, `pnpm audit` clean
- [ ] **One library per job:** it does not duplicate a table, chart, form, date or component library already in use

## Notes for the reviewer

<!-- Screenshots (synthetic data only), risks, follow-up issues. -->
