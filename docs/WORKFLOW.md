# Working with the roadmap in GitHub

GitHub issues are the source of truth for scope and progress. `scripts/github/roadmap.mjs` defines the plan, and `docs/ROADMAP.md` is generated from it.

## One-time setup
1. Install the GitHub CLI and sign in: `gh auth login`.
2. Create the repo, push this folder, and make sure `gh repo view` works inside it.
3. Preview, then seed labels, milestones and issues (re-running is safe):
   ```powershell
   node scripts/github/seed.mjs --dry-run
   node scripts/github/seed.mjs --start 2026-10-12
   ```
   The repo is a monorepo, so one run seeds frontend and backend issues together.
4. Add scripts to `package.json` once it exists: `"roadmap:seed": "node scripts/github/seed.mjs"`, `"roadmap:status": "node scripts/github/status.mjs"`.
5. Create a GitHub Project (Projects, New project, Board) with Status values Backlog, Ready, In progress, In review, Done. Turn on the built-in workflows: auto-add items from this repo, set Done when an issue closes or a PR merges. Add views: Board (group by Status), Table (group by Milestone), Roadmap (by milestone dates).

## Conventions
- **Issue IDs** are in the title, such as `[F-03] Session bootstrap`. They are stable and used to skip duplicates when re-seeding.
- **Releases:** milestones belong to releases R1 to R4 (label `release:R*`). R1 is the pilot (OPD hospital). Finish and ship a release to a pilot hospital before starting the next, and treat the last hardening issue of each release as a gate.
- **Labels:** `type:*`, `area:*`, priority `P0`/`P1`/`P2`, `size:S|M|L`, and `status:in-progress`, `status:in-review`, `status:blocked`, `status:needs-decision`.
- **Sizes** assume one developer using Claude Code: S about half a day, M one to two days, L three to five days. Split anything larger.
- **Branches:** `feat/<number>-<slug>`, `fix/<number>-<slug>`, `chore/<number>-<slug>`.
- **Commits:** Conventional Commits with the issue number, for example `feat(patients): add search (#42)`.
- **PRs:** one issue per PR, body contains `Closes #<number>`, CI must be green. Merging closes the issue.
- **Definition of ready:** dependencies closed, acceptance criteria clear, sized. **Definition of done:** the checklist at the bottom of each issue.

## Daily loop with Claude Code
1. Pick the next `Ready` issue in the current milestone (P0 first, dependencies closed).
2. Add `status:in-progress`.
3. Start `claude` in the repo and use the "Implement an issue" prompt from `docs/CLAUDE_PROMPTS.md`.
4. Review the plan, approve, review the PR, merge. Move on.
5. Anything discovered but out of scope becomes a new issue (use the Feature template), not part of the current PR.

## Monitoring
- **Milestones page:** percent complete and due dates per milestone.
- **Project board:** flow of work. Look for items stuck in review or blocked.
- **Weekly review (15 minutes):** run `node scripts/github/status.mjs`. It prints milestone progress, in-progress, in-review, blocked and needs-decision items, open P0 count, and closed issues in the last 7 days.
  - If a milestone is overdue, cut P2 and P1 issues to Backlog or re-estimate. Do not extend silently.
  - Resolve every `status:blocked` item or write down who and what unblocks it.
  - Turn `status:needs-decision` items into decisions, and record the outcome in the issue.
- **Milestone exit:** when the last P0 closes, check the milestone's exit criteria in `docs/ROADMAP.md` before starting the next one. Tag a release (`v0.<n>`) at the end of each milestone.

## Changing the plan
- New requirement: new issue with the right milestone, labels, size and dependencies.
- Changed scope: edit the issue and note why in a comment.
- Update `roadmap.mjs` only for bulk changes, and re-run the seed script (it skips existing issues; edit existing ones in GitHub).
