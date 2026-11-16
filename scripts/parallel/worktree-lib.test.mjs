import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { branchExists, clearLeftover, isWorktree, worktreeAddArgs } from './worktree-lib.mjs';

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
};
const tmp = () => mkdtempSync(path.join(tmpdir(), 'wt-test-'));

test('add reuses an existing branch and creates a missing one', () => {
  const base = tmp();
  const repo = path.join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(
    repo,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'x',
  );
  git(repo, 'branch', 'chore/1-a');
  try {
    assert.ok(branchExists(repo, 'chore/1-a'));
    assert.ok(!branchExists(repo, 'chore/2-b'));
    const dir = path.join(base, 'wt', '1');
    const args = worktreeAddArgs(repo, dir, 'chore/1-a');
    assert.deepEqual(args, ['worktree', 'add', dir, 'chore/1-a']);
    git(repo, ...args);
    assert.ok(isWorktree(repo, dir));
    assert.deepEqual(worktreeAddArgs(repo, 'd', 'chore/2-b'), [
      'worktree',
      'add',
      'd',
      '-b',
      'chore/2-b',
      'origin/main',
    ]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('clearLeftover removes only the numbered folder under the root', () => {
  const root = tmp();
  try {
    mkdirSync(path.join(root, '7', 'node_modules'), { recursive: true });
    writeFileSync(path.join(root, '7', 'node_modules', 'f'), 'x');
    mkdirSync(path.join(root, '8'));
    assert.equal(clearLeftover(root, '7'), true);
    assert.ok(!existsSync(path.join(root, '7')));
    assert.ok(existsSync(path.join(root, '8')));
    assert.equal(clearLeftover(root, '7'), false);
    assert.equal(clearLeftover(root, '..'), false);
    assert.equal(clearLeftover(root, '8/../..'), false);
    assert.ok(existsSync(root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
