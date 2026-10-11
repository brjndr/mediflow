// Run with: pnpm test:scripts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ciMode } from './ci-mode.mjs';

test('a pull request that changes only Markdown needs the docs run', () => {
  const changedFiles = ['CLAUDE.md', 'docs/WORKFLOW.md', '.claude/skills/phi-check/SKILL.md'];
  assert.equal(ciMode({ event: 'pull_request', changedFiles }), 'docs');
});

test('a pull request that changes anything else needs the full run', () => {
  for (const file of ['apps/web/src/main.tsx', '.github/workflows/ci.yml', 'package.json']) {
    const changedFiles = ['CLAUDE.md', file];
    assert.equal(ciMode({ event: 'pull_request', changedFiles }), 'full', file);
  }
});

test('a pull request whose changes cannot be read needs the full run', () => {
  assert.equal(ciMode({ event: 'pull_request', changedFiles: [] }), 'full');
  assert.equal(ciMode({ event: 'pull_request' }), 'full');
});

test('a merge that adds nothing to the tested branch is already tested', () => {
  assert.equal(ciMode({ event: 'push', mergeTree: 'abc', branchTree: 'abc' }), 'tested');
});

test('a merge that differs from the branch needs the full run', () => {
  assert.equal(ciMode({ event: 'push', mergeTree: 'abc', branchTree: 'def' }), 'full');
});

test('a push that is not a merge commit needs the full run', () => {
  assert.equal(ciMode({ event: 'push', mergeTree: 'abc', branchTree: undefined }), 'full');
  assert.equal(ciMode({ event: 'push' }), 'full');
});

test('an unknown event needs the full run', () => {
  assert.equal(ciMode({ event: 'workflow_dispatch', mergeTree: 'abc', branchTree: 'abc' }), 'full');
});
