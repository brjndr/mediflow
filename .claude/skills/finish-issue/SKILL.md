---
name: finish-issue
description: Finish the current issue (verify, run the safety checks, commit and open the PR that closes it). Use when the work for an issue is complete and the user asks to wrap up, finish or open the PR.
---

# Finish an issue

The issue number comes from the branch name (`feat/<n>-<slug>`). If the branch is `main` or has no number, stop and ask.

## Steps

1. **Re-read the issue:** `gh issue view <n>`. Go through every task, acceptance criterion and Definition of Done item and state whether it is met. Anything unmet is either finished now or reported. Never silently skipped.
2. **Verify:** `pnpm lint && pnpm typecheck && pnpm test`. Fix failures. Do not weaken or skip tests to get green. Run `pnpm e2e` only if the issue asks for it (heavy on the dev machine; CI covers the rest).
3. **Safety checks on the diff against main,** where they apply. Fix what they find before continuing:
   - `/tenant-safety-check`: data fetching, caching, query keys, permissions, routing, session.
   - `/phi-check`: anything handling patient, clinical or billing data.
   - `/module-integration-check`: any clinical or financial module.
   - `pnpm analyze`: a dependency was added or a chunk may have grown by more than 30 KB. Put the size impact in the PR.
   - `pnpm gen:api`: API route schemas changed. The committed contract must not be stale.
4. **Scope check:** `git diff main...HEAD --stat`. Everything in the diff must belong to this issue. Propose new issues for anything else.
5. **Commit:** Conventional Commits with the issue number, e.g. `feat(patients): add search (#42)`. Small, reviewable commits.
6. **Push and open the PR:** `git push -u origin <branch>`, then `gh pr create` with the title in the same style as the commit and a body covering what changed and why, how it was tested, the check results from step 3, and any follow-up issues proposed. The body ends with `Closes #<n>`.
7. **Labels:** `gh issue edit <n> --remove-label status:in-progress --add-label status:in-review`.
8. **Report:** the PR URL, what was verified, and anything left open.

## Do not

- Close the issue by hand. Merging the PR closes it.
- Merge the PR. The user reviews and merges.
- Force push, or bypass the pre-commit hook with `--no-verify`.
