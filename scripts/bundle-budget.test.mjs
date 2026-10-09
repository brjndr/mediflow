// Run with: pnpm test:scripts
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, compare, measure, stableName, toMarkdown } from './bundle-budget-lib.mjs';

const script = fileURLToPath(new URL('./bundle-budget.mjs', import.meta.url));
const created = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Random bytes do not compress, so a chunk's gzipped size is close to the size asked for. */
const filler = (kb) => randomBytes(kb * 1000);

/** Builds a fake dist folder: `chunks` maps file name to { kb, initial }. */
function makeDist(chunks) {
  const dir = mkdtempSync(join(tmpdir(), 'bundle-budget-'));
  created.push(dir);
  mkdirSync(join(dir, 'assets'));
  const tags = [];
  for (const [file, spec] of Object.entries(chunks)) {
    // An undefined entry removes a chunk from a spread base.
    if (!spec) continue;
    const { kb, initial, entry } = spec;
    writeFileSync(join(dir, 'assets', file), filler(kb));
    if (entry) tags.push(`<script type="module" crossorigin src="/assets/${file}"></script>`);
    else if (initial) tags.push(`<link rel="modulepreload" crossorigin href="/assets/${file}">`);
    else if (file.endsWith('.css')) tags.push(`<link rel="stylesheet" href="/assets/${file}">`);
  }
  writeFileSync(join(dir, 'index.html'), `<html><head>${tags.join('')}</head></html>`);
  return dir;
}

const healthy = {
  'index-AAAAAAAA.js': { kb: 40, entry: true },
  'vendor-BBBBBBBB.js': { kb: 70, initial: true },
  'NoticesPage-CCCCCCCC.js': { kb: 5 },
  'charts-DDDDDDDD.js': { kb: 200 },
  'index-EEEEEEEE.css': { kb: 5 },
};

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

test('stableName drops the content hash', () => {
  assert.equal(stableName('assets/index-C2l-WN8R.js'), 'index.js');
  assert.equal(stableName('assets/rolldown-runtime-hePW80VL.js'), 'rolldown-runtime.js');
  assert.equal(stableName('assets/index-DQfseyGI.css'), 'index.css');
});

test('measure marks the entry and its preloads as initial, and nothing else', () => {
  const assets = measure(makeDist(healthy));
  const initial = assets
    .filter((asset) => asset.initial)
    .map((asset) => asset.name)
    .sort();
  assert.deepEqual(initial, ['index.js', 'vendor.js']);
  assert.equal(assets.find((asset) => asset.name === 'NoticesPage.js').initial, false);
  assert.equal(assets.find((asset) => asset.name === 'index.css').type, 'css');
});

test('a build within every budget passes', () => {
  const result = run('--dist', makeDist(healthy));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Initial JS \| 1\d\d\.\d\d kB \| 300 kB \| ok/);
});

test('fails when initial JS is over budget', () => {
  const dist = makeDist({ ...healthy, 'vendor-BBBBBBBB.js': { kb: 290, initial: true } });
  const result = run('--dist', dist);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /::error::Initial JS is 3\d\d\.\d kB gzipped \(budget 300 kB\)/);
});

test('fails when a lazy chunk is over the route budget', () => {
  const dist = makeDist({ ...healthy, 'NoticesPage-CCCCCCCC.js': { kb: 160 } });
  const result = run('--dist', dist);
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /Lazy chunk NoticesPage\.js is 1\d\d\.\d kB gzipped \(budget 150 kB\)/,
  );
});

test('allows a named heavy chunk up to the heavy budget, and fails beyond it', () => {
  assert.equal(run('--dist', makeDist(healthy)).status, 0);
  const dist = makeDist({ ...healthy, 'charts-DDDDDDDD.js': { kb: 260 } });
  const result = run('--dist', dist);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Lazy chunk charts\.js .* \(budget 250 kB, heavy\)/);
});

test('fails when CSS is over budget', () => {
  const dist = makeDist({ ...healthy, 'index-EEEEEEEE.css': { kb: 70 } });
  const result = run('--dist', dist);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /CSS is \d\d\.\d kB gzipped \(budget 60 kB\)/);
});

test('exits with a clear message when there is no build', () => {
  const result = run('--dist', join(tmpdir(), 'no-such-dist'));
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Run "pnpm build" first/);
});

test('reports the change per chunk against a baseline and flags large growth', () => {
  const before = measure(makeDist(healthy));
  const after = measure(
    makeDist({
      ...healthy,
      'index-FFFFFFFF.js': { kb: 80, entry: true },
      'index-AAAAAAAA.js': undefined,
      'Reports-GGGGGGGG.js': { kb: 10 },
      'NoticesPage-CCCCCCCC.js': undefined,
    }),
  );
  const { rows, warnings } = compare(after, before);
  const row = (name) => rows.find((entry) => entry.name === name);

  assert.ok(row('index.js').delta > 35 * 1000);
  assert.equal(row('Reports.js').previous, undefined);
  assert.equal(row('NoticesPage.js').current, undefined);
  assert.equal(row('vendor.js'), undefined, 'unchanged chunks are left out');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /index\.js grew by 4\d\.\d kB gzipped \(more than 30 kB\)/);

  const markdown = toMarkdown({
    assets: after,
    result: check(after),
    comparison: { rows, warnings },
    baseline: before,
  });
  assert.match(markdown, /### Change against the base branch/);
  assert.match(markdown, /\| Reports\.js \| - \| 1\d\.\d\d kB \| \+1\d\.\d\d kB \|/);
  assert.match(markdown, /\*\*Needs a reason:\*\* index\.js grew/);
});

test('writes sizes as JSON and reads them back as a baseline', () => {
  const dist = makeDist(healthy);
  const json = join(dist, 'sizes.json');
  assert.equal(run('--dist', dist, '--json', json).status, 0);
  const result = run('--dist', dist, '--baseline', json);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No chunk changed size\./);
});
