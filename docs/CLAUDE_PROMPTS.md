# Prompts for Claude Code

Run `claude` in the repo root. Claude reads CLAUDE.md automatically. The hooks, permissions, skills and subagents in `.claude/` apply.

## 1. Scaffold the project (milestone M0)
```
Read CLAUDE.md in full, then read the open issues in milestone "M0 Setup" with `gh issue list --milestone "M0 Setup"` and `gh issue view <n>`.

Implement S-01 through S-07 in order, one issue at a time. The repo already contains CLAUDE.md, .claude/, docs/ and scripts/. This is a pnpm monorepo: scaffold the web app in apps/web, with packages/contract for shared API types, and a root pnpm-workspace.yaml (see Repository Layout in CLAUDE.md).

For each issue: show a short plan and wait for my approval, work on a branch named chore/<issue-number>-<slug> (or feat/ for features), commit with Conventional Commits that include the issue number, run pnpm lint, pnpm typecheck and pnpm test, then open a PR whose body ends with `Closes #<number>` and stop for my review.

Use pnpm only. Do not add dependencies beyond those named in CLAUDE.md and the issues without asking me first.
```

## 2. Build the foundation (milestone M1)
```
Read CLAUDE.md in full, then read every open issue in milestone "M1 Foundation" that is labeled area:frontend (`gh issue list --milestone "M1 Foundation" --label area:frontend`, then `gh issue view <n>` for each).

Implement them one at a time in numeric order, F-01 through F-14 (the order already respects dependencies). Check that each issue's dependencies are closed before starting it.

For each issue:
1. Enter plan mode. Present a short plan (files, types, tests) and wait for my approval.
2. Create branch feat/<issue-number>-<slug>.
3. Implement against the MSW mock backend. Follow CLAUDE.md: feature folder structure, tenant-scoped query keys, usePermission and Can (never role names), i18n keys, server-side pagination, no PHI in logs or storage.
4. Add tests: happy path, permission absent, flag off, and two tenants where relevant.
5. Run pnpm lint, pnpm typecheck and pnpm test. Then run /tenant-safety-check and /phi-check on the diff and fix every finding.
6. Commit as `feat(<scope>): <summary> (#<number>)`, open a PR whose body ends with `Closes #<number>`, and stop for my review before starting the next issue.

Constraints: no hardcoded hospital data, stay within the bundle budgets, libraries only per the dependency policy in CLAUDE.md (state the reason, size and licence in the PR), and ask me when a requirement is ambiguous instead of guessing.
```

## 3. Implement any issue
```
Implement issue #<number>.

Read it with `gh issue view <number>` and check that its dependencies are closed. Read the CLAUDE.md sections it references. If it is sized M or L, enter plan mode first and wait for my approval.

Work on branch <type>/<number>-<slug>. Follow CLAUDE.md. For a new feature use the new-feature skill, and for a list screen use the add-list-view skill. Add tests. Run pnpm lint, pnpm typecheck, pnpm test, then /tenant-safety-check and /phi-check. Commit with the issue number, open a PR ending with `Closes #<number>`, and stop.

If you find work outside this issue, do not do it. Propose a new issue (title, labels, milestone, tasks) instead.
```

## 4. Fix a bug
```
Investigate bug #<number> (`gh issue view <number>`). First reproduce it with a failing test, explain the root cause, and wait for my approval of the fix. Then fix it on branch fix/<number>-<slug>, keep the regression test, run the full checks, run the security-reviewer subagent if it touches auth, tenancy or patient data, and open a PR ending with `Closes #<number>`.
```

## 5. Review a PR before merging
```
Review PR #<number>. Use the code-reviewer subagent and the security-reviewer subagent on the diff, then summarize Must fix, Should fix and Nice to have. Do not change code.
```

## 6. Weekly planning
```
Run `node scripts/github/status.mjs` and summarize: progress per milestone, anything overdue or blocked, and open P0 work. Recommend what to cut, defer or re-estimate to hit the current milestone's exit criteria. Propose issue edits, but do not apply them until I approve.
```

## 7. Plan a module milestone before building it
Use this at the start of every module milestone (lab, pharmacy, admissions, billing and so on).
```
Read CLAUDE.md in full, especially "Product Scope: End-to-End Patient Journey", then read every issue in milestone "<milestone title>" (`gh issue list --milestone "<title>"`, `gh issue view <n>` for each).

Do not write code yet. Produce a design for the whole milestone:
1. How it uses Encounter, the unified Order model, the charge ledger and domain events (which events it consumes and emits).
2. Tables and state machines (with the constraints or row locks that make concurrency safe).
3. Permissions (resource:action) and default role grants, feature flag, per-hospital settings, and extension slots it contributes to.
4. API endpoints (TypeBox schemas) and the screens, mapped to the issues.
5. Risks, open questions, and anything in CLAUDE.md that should change.
Wait for my approval, then implement the issues one at a time using prompt 3.
```
