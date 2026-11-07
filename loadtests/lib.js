/* global __ENV */
// Shared helpers for the k6 scenarios. k6 runs plain JavaScript (not Node): no imports from the repo.
import http from 'k6/http';
import { check, fail } from 'k6';

export const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
// The password of every sample account made by `pnpm --filter api db:seed`. Staging uses its own.
export const PASSWORD = __ENV.STAFF_PASSWORD || 'sample-staff-local-only';

// The API refuses a write whose Origin is not APP_BASE_URL. Reads do not need it, but it is always sent.
export const ORIGIN = __ENV.APP_ORIGIN || 'http://localhost:5173';

// Sample accounts that belong to one hospital each (a user in two hospitals has to pick one first).
export const HOSPITAL_A = [
  'admin@sample-hospital.test',
  'nurse@sample-hospital.test',
  'pharmacy@sample-hospital.test',
  'stores@sample-hospital.test',
];
export const HOSPITAL_B = ['reception@riverside-clinic.test', 'billing@riverside-clinic.test'];

/**
 * Signs in once per account: the sign-in route allows 10 attempts a minute per address and Argon2id is
 * meant to be slow, so a load test must not sign in on every iteration. Returns the Cookie header value.
 */
export function signIn(email) {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password: PASSWORD }), {
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    tags: { name: 'login' },
    // A fresh jar each time: signing in with the cookie of the last account would end that session.
    jar: new http.CookieJar(),
  });
  if (!check(res, { 'signed in': (r) => r.status === 200 })) {
    fail(`sign-in failed for ${email}: ${res.status}`);
  }
  const name = Object.keys(res.cookies)[0];
  return `${name}=${res.cookies[name][0].value}`;
}

export function signInAll(emails) {
  const cookies = {};
  for (const email of emails) cookies[email] = signIn(email);
  return cookies;
}

function headers(cookie) {
  return { cookie, origin: ORIGIN, 'content-type': 'application/json' };
}

function day(offset) {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
}

function get(path, name, cookie, tags) {
  return http.get(`${BASE_URL}${path}`, { headers: headers(cookie), tags: { name, ...tags } });
}

function post(path, name, body, cookie, tags) {
  return http.post(`${BASE_URL}${path}`, JSON.stringify(body), {
    headers: headers(cookie),
    tags: { name, ...tags },
  });
}

/**
 * The read mix of a working hospital: mostly the patient search and the queue board. `name` tags each
 * request so thresholds can be set per route; `tags` adds more (the hospital, for the noisy-neighbour run).
 */
export const READS = [
  {
    weight: 40,
    call: (c, t) => post('/patients/search', 'patients_search', { q: 'a', limit: 25 }, c, t),
  },
  { weight: 25, call: (c, t) => get('/session', 'session', c, t) },
  { weight: 20, call: (c, t) => get('/queue/display', 'queue_display', c, t) },
  { weight: 10, call: (c, t) => get('/inventory/stock?limit=25', 'stock_list', c, t) },
  {
    weight: 5,
    call: (c, t) =>
      post('/reports/opd_census', 'report_opd_census', { from: day(-7), to: day(0) }, c, t),
  },
];

const TOTAL = READS.reduce((sum, r) => sum + r.weight, 0);

export function pickRead() {
  let n = Math.random() * TOTAL;
  for (const r of READS) {
    n -= r.weight;
    if (n < 0) return r;
  }
  return READS[0];
}
