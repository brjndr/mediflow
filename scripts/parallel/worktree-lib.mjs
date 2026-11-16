// Helpers of worktree.mjs, apart so a test can run them against a temporary repository.
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

export const branchExists = (cwd, branch) =>
  spawnSync('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], { cwd }).status ===
  0;

// Arguments for `git worktree add`: a new branch from origin/main, or the branch that is already there.
export const worktreeAddArgs = (cwd, dir, branch) =>
  branchExists(cwd, branch)
    ? ['worktree', 'add', dir, branch]
    : ['worktree', 'add', dir, '-b', branch, 'origin/main'];

// Deletes a folder that is no longer a git worktree (what `remove` leaves behind when node_modules is
// locked). Only `<wtRoot>/<issue>` with a numeric issue, never anything outside the worktree root.
export const clearLeftover = (wtRoot, issue) => {
  if (!/^\d+$/.test(String(issue))) return false;
  const root = path.resolve(wtRoot);
  const dir = path.resolve(root, String(issue));
  if (path.dirname(dir) !== root || !existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  return true;
};

export const isWorktree = (cwd, dir) => {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd, encoding: 'utf8' });
  const norm = (p) => path.resolve(p).split(path.sep).join('/').toLowerCase();
  return (r.stdout ?? '')
    .split('\n')
    .some((l) => l.startsWith('worktree ') && norm(l.slice(9).trim()) === norm(dir));
};
