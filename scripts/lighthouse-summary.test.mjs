import { test } from 'node:test';
import assert from 'node:assert/strict';
import { median, render, summarize } from './lighthouse-summary.mjs';

const lhr = (url, t, bench, tbt) => ({
  finalUrl: url,
  fetchTime: t,
  environment: { benchmarkIndex: bench },
  audits: { 'total-blocking-time': { numericValue: tbt } },
});

test('median of odd and even lists', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test('summarize groups by url and drops duplicate copies', () => {
  const a = lhr('http://x/', 't1', 1000, 100);
  const rows = summarize([a, { ...a }, lhr('http://x/', 't2', 1200, 300)]);
  assert.deepEqual(rows.get('http://x/'), { bench: [1000, 1200], tbt: [100, 300] });
});

test('render prints a table and handles no reports', () => {
  const text = render('desktop', summarize([lhr('http://x/', 't1', 1000, 100)]));
  assert.match(text, /\| http:\/\/x\/ \| 1 \| 1000 \| 100 \|/);
  assert.match(render('desktop', new Map()), /No Lighthouse reports/);
});
