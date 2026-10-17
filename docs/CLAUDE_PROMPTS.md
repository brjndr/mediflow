# Prompts for Claude Code

Run `claude` in the repo root. Claude reads CLAUDE.md automatically. The hooks, permissions, skills and subagents in `.claude/` apply.

## 1. Implement any issue

```
Implement issue #<number>.

Read it with `gh issue view <number>` and check that its dependencies are closed. Read the CLAUDE.md sections it references. If it is sized M or L, enter plan mode first and wait for my approval.

Work on branch <type>/<number>-<slug>. Follow CLAUDE.md. For a new feature use the new-feature skill, and for a list screen use the add-list-view skill. Add tests. The accessibility target is WCAG 2.2 AA: every changed screen gets axe in its unit test and in Playwright, and a keyboard test of its main task (CLAUDE.md, Accessibility). Then follow the finish-issue skill: typecheck and the tests for what changed, one security-reviewer pass, commit with the issue number, open a PR ending with `Closes #<number>`, merge it when CI is green, and stop.

If you find work outside this issue, do not do it. Propose a new issue (title, labels, milestone, tasks) instead.
```

## 2. Fix a bug

```
Investigate bug #<number> (`gh issue view <number>`). First reproduce it with a failing test, explain the root cause, and wait for my approval of the fix. Then fix it on branch fix/<number>-<slug>, keep the regression test, run the full checks, run the security-reviewer subagent if it touches auth, tenancy or patient data, and open a PR ending with `Closes #<number>`.
```

## 3. Review a PR before merging

```
Review PR #<number>. Use the code-reviewer subagent and the security-reviewer subagent on the diff, then summarize Must fix, Should fix and Nice to have. Do not change code.
```

## 4. Weekly planning

```
Run `node scripts/github/status.mjs` and summarize: progress per milestone, anything overdue or blocked, and open P0 work. Recommend what to cut, defer or re-estimate to hit the current milestone's exit criteria. Propose issue edits, but do not apply them until I approve.
```

## 5. Plan a module milestone before building it

Use this at the start of every module milestone (lab, pharmacy, admissions, billing and so on).

```
Read CLAUDE.md in full, especially "Product Scope: End-to-End Patient Journey", and `docs/PRODUCT.md`, then read every issue in milestone "<milestone title>" (`gh issue list --milestone "<title>"`, `gh issue view <n>` for each).

Do not write code yet. Produce a design for the whole milestone:
1. How it uses Encounter, the unified Order model, the charge ledger and domain events (which events it consumes and emits).
2. Tables and state machines (with the constraints or row locks that make concurrency safe).
3. Permissions (resource:action) and default role grants, feature flag, per-hospital settings, and extension slots it contributes to.
4. API endpoints (TypeBox schemas) and the screens, mapped to the issues.
5. Risks, open questions, and anything in CLAUDE.md that should change.
Wait for my approval, then implement the issues one at a time using prompt 1.
```
