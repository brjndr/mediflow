---
name: start-issue
description: Start work on a GitHub issue the project way (read it, confirm dependencies are closed, create the branch, plan before coding). Use when the user says to start, pick up or implement an issue, e.g. "/start-issue 42".
---

# Start an issue

Follow "Workflow (GitHub issues)" in CLAUDE.md and `docs/WORKFLOW.md`. One issue at a time.

## Steps

1. **Read the issue:** `gh issue view <n>` (tasks, acceptance criteria, dependencies, Definition of Done, labels). If no number was given, run `node scripts/github/status.mjs` and `gh issue list` and propose the next Ready issue in the current milestone (P0 first), then wait for the user to choose.
2. **Check dependencies:** run `gh issue view <dep> --json state,title` for each one listed. If any is open, stop and report which. Do not start, and do not add `status:blocked` without a comment stating the blocker.
3. **Check the working tree:** `git status` must be clean and no other issue branch should be half-finished. If not, report it and ask.
4. **Branch from an up-to-date main:** `feat/<n>-<slug>`, `fix/<n>-<slug>` or `chore/<n>-<slug>`, chosen from the issue's `type:*` label. Slug is a short kebab-case form of the title without the `[ID]` prefix.
5. **Mark in progress:** `gh issue edit <n> --add-label status:in-progress`.
6. **Plan:**
   - Size M or L: present a short plan (files to add or change, permissions and feature flag, contract changes, tests, anything unclear) and **wait for approval** before writing code.
   - Size S: state the approach in two or three lines and proceed.
7. **Pick the right skills for the work:** `/new-feature` for a new module, `/add-list-view` for list screens. Note now which checks `/finish-issue` will need.

## Do not

- Widen scope. Anything discovered but out of scope becomes a proposed new issue (title, labels, milestone, tasks), shown to the user, not part of this change.
- Change the stack or folder structure without asking.
- Commit on `main`.
