// Run with: pnpm test:scripts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { auditProblems } from './audit-gate-lib.mjs';

const high = {
  severity: 'high',
  github_advisory_id: 'GHSA-aaaa',
  module_name: 'foo',
  title: 'bad',
};
const moderate = { ...high, severity: 'moderate', github_advisory_id: 'GHSA-bbbb' };
const today = '2026-11-19';

test('a high or critical advisory fails, a moderate one does not', () => {
  assert.equal(auditProblems({ 1: high }, [], today).length, 1);
  assert.equal(auditProblems({ 1: { ...high, severity: 'critical' } }, [], today).length, 1);
  assert.deepEqual(auditProblems({ 1: moderate }, [], today), []);
  assert.deepEqual(auditProblems({}, [], today), []);
});

test('an allowed advisory passes until its expiry date', () => {
  const entry = { id: 'GHSA-aaaa', reason: 'dev only, no patch', expires: '2026-12-31' };
  assert.deepEqual(auditProblems({ 1: high }, [entry], today), []);
  assert.equal(auditProblems({ 1: high }, [{ ...entry, expires: '2026-11-18' }], today).length, 2);
});

test('an entry without a reason or a date is refused', () => {
  assert.equal(auditProblems({}, [{ id: 'GHSA-aaaa', expires: '2026-12-31' }], today).length, 1);
  assert.equal(auditProblems({}, [{ id: 'GHSA-aaaa', reason: 'x' }], today).length, 1);
});
