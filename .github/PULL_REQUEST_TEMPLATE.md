## Summary

<!-- What changed and why. The PR does the work of one issue. -->

<!-- One "Closes" line per issue this change fully resolves: the issue it was opened for, and any other, with a sentence saying why. -->

Closes #

## Checks

- [ ] CI is green (it runs the full lint, typecheck, test, build and end-to-end suites)
- [ ] Tests cover happy path, validation, permission absent, flag off, and two tenants where relevant
- [ ] `/tenant-safety-check` and `/phi-check` checklists applied to this diff, by the `security-reviewer` pass or by hand (if data or access is touched)
- [ ] No PHI in logs, URLs, storage, fixtures, or screenshots
- [ ] Accessibility (WCAG 2.2 AA): keyboard and axe checked for changed screens, or no screen changed
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
