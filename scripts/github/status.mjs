// Prints roadmap progress from GitHub: milestone burn-up, in-progress, blocked, open P0 and recent throughput.
// Usage: node scripts/github/status.mjs [--repo owner/name]
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function gh(a) {
  const r = spawnSync('gh', a, { encoding: 'utf8' });
  if (r.error) {
    console.error('The GitHub CLI (gh) was not found. Install it and run: gh auth login');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return r.stdout;
}

const repo =
  opt('repo') ?? JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
const bar = (pct) => '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
const now = new Date();

const ms = gh([
  'api',
  `repos/${repo}/milestones?state=all&per_page=100`,
  '--paginate',
  '--jq',
  '.[] | {title,open_issues,closed_issues,due_on}',
])
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l))
  .sort((a, b) => {
    const n = (t) => (/^M(\d+)/.exec(t.title) ? Number(/^M(\d+)/.exec(t.title)[1]) : 999);
    return n(a) - n(b);
  });

let open = 0,
  closed = 0;
console.log(`\nRoadmap status for ${repo}\n`);
for (const m of ms) {
  const total = m.open_issues + m.closed_issues;
  const pct = total ? Math.round((m.closed_issues / total) * 100) : 0;
  open += m.open_issues;
  closed += m.closed_issues;
  const overdue = m.due_on && new Date(m.due_on) < now && m.open_issues > 0 ? '  OVERDUE' : '';
  const due = m.due_on ? `  due ${m.due_on.slice(0, 10)}` : '';
  console.log(
    `${m.title.padEnd(36)} ${bar(pct)} ${String(pct).padStart(3)}%  ${m.closed_issues}/${total}${due}${overdue}`,
  );
}
const overall = open + closed ? Math.round((closed / (open + closed)) * 100) : 0;
console.log(`\nOverall: ${bar(overall)} ${overall}%  (${closed} closed, ${open} open)`);

const list = (label, state = 'open', extra = []) =>
  JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      state,
      '--label',
      label,
      '--limit',
      '100',
      '--json',
      'number,title,milestone',
      ...extra,
    ]),
  );
const show = (title, items) => {
  console.log(`\n${title} (${items.length})`);
  for (const it of items)
    console.log(`  #${it.number} ${it.title}${it.milestone ? `  [${it.milestone.title}]` : ''}`);
};

show('In progress', list('status:in-progress'));
show('In review', list('status:in-review'));
show('Blocked', list('status:blocked'));
show('Needs decision', list('status:needs-decision'));
const p0 = list('P0').filter((i) => i.milestone && !/^Backlog/.test(i.milestone.title));
console.log(`\nOpen P0 issues: ${p0.length}`);

const since = new Date(now.getTime() - 7 * 86400000).toISOString().slice(0, 10);
const recent = JSON.parse(
  gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'closed',
    '--search',
    `closed:>=${since}`,
    '--limit',
    '200',
    '--json',
    'number',
  ]),
);
console.log(`Closed in the last 7 days: ${recent.length}\n`);
