---
name: finish-issue
description: Finish the current issue (verify, run the safety checks, commit and open the PR that closes it). Use when the work for an issue is complete and the user asks to wrap up, finish or open the PR.
---

# Finish an issue

The issue number comes from the branch name (`feat/<n>-<slug>`). If the branch is `main` or has no number, stop and ask.

## Steps

1. **Re-read the issue:** `gh issue view <n>`. Go through every task, acceptance criterion and Definition of Done item and state whether it is met. Anything unmet is either finished now or reported. Never silently skipped.
2. **Verify what changed, locally:** `pnpm typecheck`, then only the tests for the code this issue touched, e.g. `pnpm --filter web test src/features/auth` or `pnpm --filter api test src/core/session`. Fix failures. Do not weaken or skip tests to get green. The commit hook lints and formats the changed files, and CI runs the full lint, test, build and end-to-end suites (step 7), so do not run those across the whole repo here. Run `pnpm e2e` only if the issue asks for it.
3. **Review the diff against main once,** where it applies. Fix what is found before continuing:
   - **Security:** run the `security-reviewer` subagent when the change touches data fetching, caching, query keys, permissions, routing, session, logging, storage, or patient, clinical or billing data. It applies the `/tenant-safety-check` and `/phi-check` checklists (and `/module-integration-check` for a clinical or financial module) in one pass, which is what the Definition of Done asks for. Do not also run those skills yourself.
   - **Quality:** run the `code-reviewer` subagent for an issue sized M or L.
   - `pnpm analyze`: a dependency was added or a chunk may have grown by more than 30 KB. Put the size impact in the PR.
   - `pnpm gen:api`: API route schemas changed. The committed contract must not be stale.
4. **Scope check:** `git diff main...HEAD --stat`. Everything in the diff must belong to this issue. Propose new issues for anything else.
5. **Commit:** Conventional Commits with the issue number, e.g. `feat(patients): add search (#42)`. Small, reviewable commits.
6. **Push and open the PR:** `git push -u origin <branch>`, then `gh pr create` with the title in the same style as the commit and a body covering what changed and why, how it was tested, the check results from step 3, and any follow-up issues proposed. The body ends with `Closes #<n>`.
7. **Wait for CI:** `gh pr checks <pr> --watch`. If a check fails, read its log, fix the cause, push, and wait again.
8. **Merge when every check is green:** `gh pr merge <pr> --merge --delete-branch`. Merging closes the issue.
9. **Clean up:** `gh issue edit <n> --remove-label status:in-progress`, then `git switch main`, `git pull --ff-only` and `git fetch --prune`, so the next issue starts from an up-to-date main.
10. **Report:** the PR URL, what was verified, and anything left open.

## Do not

- Close the issue by hand. Merging the PR closes it.
- Merge with a failed or pending check, or when the user asked to review the PR first. Then add `status:in-review` in place of `status:in-progress` and stop after step 7.
- Force push, or bypass the pre-commit hook with `--no-verify`.
