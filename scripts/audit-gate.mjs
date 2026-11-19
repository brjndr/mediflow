// Fails on a high or critical advisory in any dependency, dev ones included, unless it is in
// scripts/audit-allowlist.json with a reason and an expiry date (#1068). Production dependencies
// are also checked by `pnpm audit --prod`, which has no allowlist.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { auditProblems } from './audit-gate-lib.mjs';

let json;
try {
  // pnpm audit exits non-zero when it finds anything; the report is still on stdout.
  json = execSync('pnpm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
  json = error.stdout?.toString() ?? '';
}
let advisories;
try {
  advisories = JSON.parse(json).advisories;
} catch {
  console.error('audit gate: pnpm audit gave no report we can read');
  process.exit(1);
}
const allowlist = JSON.parse(
  readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8'),
);
const problems = auditProblems(advisories, allowlist, new Date().toISOString().slice(0, 10));
if (problems.length > 0) {
  for (const problem of problems) console.error(`audit gate: ${problem}`);
  process.exit(1);
}
console.log(
  `audit gate: no unlisted high or critical advisories (${Object.keys(advisories ?? {}).length} found in all)`,
);
