/* global __ENV, __VU */
// Mixed-tenant load: staff of two hospitals work at a realistic pace at the same time.
// Run:  k6 run loadtests/mixed.js   (BASE_URL, STAFF_PASSWORD, APP_ORIGIN, VUS and DURATION change it)
import { check, sleep } from 'k6';
import { HOSPITAL_A, HOSPITAL_B, signInAll, pickRead } from './lib.js';

const VUS = Number(__ENV.VUS || 12);
const DURATION = __ENV.DURATION || '5m';

export const options = {
  scenarios: {
    hospital_a: {
      executor: 'constant-vus',
      vus: Math.ceil(VUS * 0.6),
      duration: DURATION,
      env: { HOSPITAL: 'A' },
    },
    hospital_b: {
      executor: 'constant-vus',
      vus: Math.floor(VUS * 0.4),
      duration: DURATION,
      env: { HOSPITAL: 'B' },
    },
  },
  thresholds: {
    // Targets: docs/PERFORMANCE.md, "Load testing".
    'http_req_duration{name:patients_search}': ['p(95)<300', 'p(99)<800'],
    'http_req_duration{name:session}': ['p(95)<200'],
    'http_req_duration{name:queue_display}': ['p(95)<300'],
    'http_req_duration{name:stock_list}': ['p(95)<400'],
    // A report is worked out on the spot from the replica, under its own time limit.
    'http_req_duration{name:report_opd_census}': ['p(95)<1500'],
    // At a normal pace nothing is refused and nothing fails (403 is counted as ok below).
    'checks{check:status ok}': ['rate>0.99'],
  },
};

export function setup() {
  return { A: signInAll(HOSPITAL_A), B: signInAll(HOSPITAL_B) };
}

export default function (data) {
  const pool = __ENV.HOSPITAL === 'B' ? data.B : data.A;
  const emails = Object.keys(pool);
  const res = pickRead().call(pool[emails[(__VU - 1) % emails.length]], {});
  // The reception and billing roles may not read every route: 403 is a correct answer there.
  check(res, { 'status ok': (r) => r.status === 200 || r.status === 403 }, { check: 'status ok' });
  // Think time: a person looks at the screen before the next action.
  sleep(3 + Math.random() * 2);
}
