// Run with: pnpm test:scripts
// Every action a workflow uses is pinned to a full commit SHA (#1079): a tag can be moved to other
// code, a commit cannot. The tag stays in a comment, and Dependabot (github-actions) moves both.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';

const WORKFLOWS = new URL('../.github/workflows/', import.meta.url);

/** The `uses:` values of a workflow that are not pinned to a commit, with their line numbers. */
export function unpinnedUses(text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    const match = /^\s*(?:-\s+)?uses:\s*['"]?([^\s'"#]+)/.exec(line);
    if (!match) return;
    const target = match[1];
    // An action in this repository is reviewed with the change itself.
    if (target.startsWith('./')) return;
    // A container image must name its digest.
    if (target.startsWith('docker://')) {
      if (!/@sha256:[0-9a-f]{64}$/.test(target)) found.push(`${index + 1}: ${target}`);
      return;
    }
    if (!/@[0-9a-f]{40}$/.test(target)) found.push(`${index + 1}: ${target}`);
  });
  return found;
}

test('a tag or a branch is unpinned, a full commit SHA is pinned', () => {
  const sha = 'a'.repeat(40);
  const text = [
    '      - uses: actions/checkout@v7',
    `      - uses: actions/checkout@${sha} # v7.0.1`,
    '      - uses: owner/action@main',
    `        uses: github/codeql-action/init@${sha.slice(0, 7)}`,
    `      - uses: "actions/cache@${sha}"`,
    '      - uses: ./.github/actions/local',
    '      - uses: docker://alpine:3.20',
    `      - uses: docker://alpine@sha256:${'b'.repeat(64)}`,
  ].join('\n');
  assert.deepEqual(unpinnedUses(text), [
    '1: actions/checkout@v7',
    '3: owner/action@main',
    `4: github/codeql-action/init@${sha.slice(0, 7)}`,
    '7: docker://alpine:3.20',
  ]);
});

test('every workflow pins its actions to a commit', () => {
  const files = readdirSync(WORKFLOWS).filter((name) => /\.ya?ml$/.test(name));
  assert.ok(files.length > 0);
  for (const name of files) {
    const text = readFileSync(new URL(name, WORKFLOWS), 'utf8');
    assert.deepEqual(unpinnedUses(text), [], `${name} has actions not pinned to a commit SHA`);
  }
});
