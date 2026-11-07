/* global __ENV, __VU */
// Noisy neighbour: hospital A hammers the API with no think time while hospital B works normally.
// Passes when B is unaffected (same targets as mixed.js, never a 429) and A is held back (429 with Retry-After).
// Run:  k6 run loadtests/noisy-neighbour.js
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { HOSPITAL_A, HOSPITAL_B, signInAll, pickRead, READS } from './lib.js';

const DURATION = __ENV.DURATION || '3m';
const limitedA = new Counter('a_rate_limited');
const limitedB = new Counter('b_rate_limited');

export const options = {
  scenarios: {
    a_flood: {
      executor: 'constant-vus',
      vus: Number(__ENV.FLOOD_VUS || 20),
      duration: DURATION,
      exec: 'flood',
    },
    b_normal: {
      executor: 'constant-vus',
      vus: Number(__ENV.B_VUS || 5),
      duration: DURATION,
      exec: 'normal',
    },
  },
  thresholds: {
    'http_req_duration{hospital:B,name:patients_search}': ['p(95)<300'],
    'http_req_duration{hospital:B,name:session}': ['p(95)<200'],
    'http_req_duration{hospital:B,name:queue_display}': ['p(95)<300'],
    b_rate_limited: ['count==0'],
    a_rate_limited: ['count>0'],
    // 5xx under the flood is a defect; 429 is the design.
    'checks{check:no server error}': ['rate==1'],
    'checks{check:has Retry-After}': ['rate==1'],
  },
};

export function setup() {
  return { A: signInAll(HOSPITAL_A), B: signInAll(HOSPITAL_B) };
}

export function flood(data) {
  const emails = Object.keys(data.A);
  const res = pickRead().call(data.A[emails[(__VU - 1) % emails.length]], { hospital: 'A' });
  if (res.status === 429) {
    limitedA.add(1);
    check(
      res,
      { 'has Retry-After': (r) => !!r.headers['Retry-After'] },
      { check: 'has Retry-After' },
    );
  }
  check(res, { 'no server error': (r) => r.status < 500 }, { check: 'no server error' });
}

export function normal(data) {
  const emails = Object.keys(data.B);
  // The first three reads (search, session, queue board) are open to both of B's roles.
  const read = READS[Math.floor(Math.random() * 3)];
  const res = read.call(data.B[emails[(__VU - 1) % emails.length]], { hospital: 'B' });
  if (res.status === 429) limitedB.add(1);
  check(res, { 'no server error': (r) => r.status < 500 }, { check: 'no server error' });
  sleep(3 + Math.random() * 2);
}
