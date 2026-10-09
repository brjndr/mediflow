// Checks the built web app against the bundle budgets and exits non-zero when one is exceeded.
//
// Usage (after `pnpm build`):
//   node scripts/bundle-budget.mjs                         check apps/web/dist
//   node scripts/bundle-budget.mjs --json sizes.json       also write the measured sizes
//   node scripts/bundle-budget.mjs --baseline base.json    also report the change per chunk
//   node scripts/bundle-budget.mjs --dist path/to/dist     check another build
//   node scripts/bundle-budget.mjs --json f --measure-only write sizes, no report, always exit 0
//
// In GitHub Actions the report is appended to the job summary, and chunks that grew by more than
// the warning threshold are raised as warnings. See scripts/bundle-budget-lib.mjs for the budgets.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { check, compare, measure, toMarkdown } from './bundle-budget-lib.mjs';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

const distDir = option('dist') ?? 'apps/web/dist';
let assets;
try {
  assets = measure(distDir);
} catch (error) {
  console.error(`Cannot read the build in ${distDir}. Run "pnpm build" first.`);
  console.error(error instanceof Error ? error.message : error);
  process.exit(2);
}

const jsonPath = option('json');
if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(assets, null, 2)}\n`);
// Used for the base branch in CI: record its sizes without reporting or judging them.
if (args.includes('--measure-only')) process.exit(0);

const baselinePath = option('baseline');
const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined;
const result = check(assets);
const comparison = baseline ? compare(assets, baseline) : undefined;
const report = toMarkdown({ assets, result, comparison, baseline });

console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
for (const warning of comparison?.warnings ?? []) console.log(`::warning::${warning}`);

if (result.violations.length > 0) {
  for (const violation of result.violations) console.error(`::error::${violation}`);
  console.error('Bundle budget exceeded. Split or lazy-load the code, or justify a budget change.');
  process.exit(1);
}
