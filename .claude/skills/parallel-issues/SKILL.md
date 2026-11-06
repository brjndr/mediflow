---
name: parallel-issues
description: Resolve many GitHub issues at once by spawning several issue-worker agents, each in its own git worktree, and merging their PRs as CI passes. Use when the user asks to work through many or all open issues, in parallel, as fast as possible, e.g. "/parallel-issues M6" or "/parallel-issues 483 482 460".
---

# Resolve issues in parallel

You are the orchestrator. You choose issues, spawn `issue-worker` agents (one per issue, `subagent_type: "issue-worker"`, `run_in_background: true`), and keep the pipeline full. You do not implement issues yourself.

## 1. Choose the batch

Arguments are issue numbers, a milestone name, or empty (everything open).

```
gh issue list --state open --limit 200 --json number,title,labels,milestone,body
```

Keep an issue only if **all** hold:

- no `status:needs-decision`, `status:blocked` or `status:in-progress` label; not in `FUT-*`, not `area:infra`/`area:product` (they need a human or a cloud account);
- every dependency it names (`Depends on #x` in the body) is closed, or is in an earlier wave of this run;
- size S or M. Size L (and anything labelled P0 hardening/gate) only if the user named it, and then run it alone in its wave.

Skip issues whose milestone is a later release than the current one unless the user asked for them: the build order in CLAUDE.md applies (module before the module that depends on it; a feature's `BE-*` API issue before or together with its screens).

## 2. Plan waves that do not collide

Two workers must not run together if they touch the same module (same `features/<folder>` in web or api), the same migration area, or the contract of the same resource. Group by module from the title/milestone; at most one worker per module per wave. Pairs that share a module go to different waves. Put frontend and backend issues of one feature in the same worker only when the issue says they share a PR; otherwise backend first.

**Concurrency: at most 3 workers at once** on this machine (2 cores, 16 GB, one shared Postgres). Use 2 when any worker is size L or runs Playwright. Start the next issue the moment one finishes, not at the end of the wave.

Show the user the wave plan (issue, module, size) in a short table, then proceed without waiting unless the plan contains a size L issue or fewer than 3 viable issues.

## 3. Run

Check once that Postgres is up (`docker compose ps`), else `docker compose up -d`. For each issue spawn a worker with a prompt of this form and nothing more (the agent definition has the rules):

> Resolve GitHub issue #<n> ([title]). Type: <feat|fix|chore>. Suggested slug: <slug>. Other workers are active on: <their issues and modules>. Avoid their files.

When a worker reports:

- `MERGED`: record it; `git pull --ff-only` in the main checkout; spawn the next issue.
- `SKIPPED`: note the reason; do not retry.
- `BLOCKED`: read the cause. If it is a conflict with a just-merged PR, `SendMessage` the same worker to rebase and continue. If CI is red for a reason outside the PR, note it and move on.
  After a contract or migration PR merges, tell active workers (SendMessage) to rebase before their final push.

## 4. Finish

Print a table: merged (PR links), skipped (why), blocked (workspace path), plus the new issues the workers proposed (create them only if the user agrees). Update the "Current Status" section of CLAUDE.md and `docs/STATUS.md` once, in one small chore PR, for any module finished by this run, not inside the workers' PRs.

## Do not

- Spawn more than 3 workers, spawn a worker per task inside an issue, or let two workers share a worktree or database.
- Merge a PR with a red check, force push, or bypass hooks.
- Start `status:needs-decision` issues by guessing the decision; list them for the user instead.
