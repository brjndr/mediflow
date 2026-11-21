// Run with: pnpm test:scripts
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { headersFor, parseHeadersFile } from './zap-serve-lib.mjs';

const SAMPLE = `# a comment
/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
/assets/*
  Cache-Control: public, max-age=31536000, immutable
/index.html
  Cache-Control: no-cache
`;

test('a path gets every matching rule, later ones adding to or overriding earlier ones', () => {
  const rules = parseHeadersFile(SAMPLE);
  assert.deepEqual(headersFor(rules, '/patients/1'), {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  assert.equal(
    headersFor(rules, '/assets/app.js')['Cache-Control'],
    'public, max-age=31536000, immutable',
  );
  assert.equal(headersFor(rules, '/index.html')['Cache-Control'], 'no-cache');
  assert.equal(headersFor(rules, '/index.htmlx')['Cache-Control'], undefined);
});

test("the web app's own _headers file is read, with the security headers on every path", () => {
  const text = readFileSync(new URL('../apps/web/public/_headers', import.meta.url), 'utf8');
  const headers = headersFor(parseHeadersFile(text), '/patients/1');
  for (const name of ['X-Content-Type-Options', 'Referrer-Policy', 'Strict-Transport-Security']) {
    assert.ok(headers[name], name);
  }
});
