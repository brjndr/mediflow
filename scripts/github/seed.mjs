// Seeds labels, milestones and issues from roadmap.mjs using the GitHub CLI (gh).
// Safe to re-run: existing labels are updated, existing milestones and issues (matched by "[ID]" in the title) are skipped.
//
// Usage:
//   node scripts/github/seed.mjs --dry-run
//   node scripts/github/seed.mjs [--repo owner/name] [--areas frontend,infra,docs,security,product] [--start 2026-10-12]
//   node scripts/github/seed.mjs --md > docs/ROADMAP.md
import { spawnSync } from 'node:child_process';
import { milestones, labels, flatIssues, typeOf, dod } from './roadmap.mjs';

const args = process.argv.slice(2);
const has = (n) => args.includes(`--${n}`);
const opt = (n) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const areaFilter = opt('areas')
  ?.split(',')
  .map((s) => s.trim());
const all = flatIssues();
const byId = Object.fromEntries(all.map((i) => [i.id, i]));
const selected = all.filter((i) => !areaFilter || areaFilter.includes(i.area));

function dueDates(start) {
  const out = {};
  if (!start) return out;
  let d = new Date(`${start}T00:00:00Z`);
  for (const m of milestones) {
    if (!m.weeks) continue;
    d = new Date(d.getTime() + m.weeks * 7 * 86400000);
    out[m.title] = new Date(d.getTime() - 1000).toISOString().replace(/\.\d+Z$/, 'Z');
  }
  return out;
}

if (has('md')) {
  const lines = [
    '# Roadmap',
    '',
    'Generated from `scripts/github/roadmap.mjs`. Track progress in GitHub milestones and issues, or run `node scripts/github/status.mjs`.',
    '',
  ];
  const total = milestones.reduce((s, m) => s + m.weeks, 0);
  lines.push(
    `Estimated duration: about ${total} weeks for one developer using Claude Code (rough, re-plan at each milestone).`,
    '',
  );
  lines.push('| Milestone | Release | Weeks | Issues | Exit criteria |', '|---|---|---|---|---|');
  for (const m of milestones)
    lines.push(
      `| ${m.title} | ${m.release || '-'} | ${m.weeks || '-'} | ${m.issues.length} | ${m.exit} |`,
    );
  lines.push(
    '',
    'Releases: **R1** pilot OPD hospital, **R2** inpatient, **R3** emergency, surgery and insurance, **R4** records and operations. Ship each release to a pilot hospital before starting the next.',
  );
  lines.push(
    '',
    'Sizes: S about half a day, M 1 to 2 days, L 3 to 5 days (split if larger). Priorities: P0 must have, P1 should have, P2 nice to have.',
    '',
  );
  for (const m of milestones) {
    lines.push(
      `## ${m.title}${m.release ? ` (${m.release})` : ''}`,
      '',
      m.goal,
      '',
      '| ID | Title | Area | Pri | Size | Depends on |',
      '|---|---|---|---|---|---|',
    );
    for (const i of m.issues)
      lines.push(
        `| ${i.id} | ${i.title} | ${i.area} | ${i.pri} | ${i.size} | ${i.deps.join(', ') || '-'} |`,
      );
    lines.push('');
  }
  console.log(lines.join('\n'));
  process.exit(0);
}

const dry = has('dry-run');

function gh(a, input) {
  const r = spawnSync('gh', a, { encoding: 'utf8', input });
  if (r.error) {
    console.error('The GitHub CLI (gh) was not found. Install it and run: gh auth login');
    process.exit(1);
  }
  return r;
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const repo = dry
  ? (opt('repo') ?? '<current repo>')
  : (opt('repo') ??
    JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner']).stdout).nameWithOwner);

function issueBody(i) {
  const m = milestones.find((x) => x.title === i.milestone);
  const deps = i.deps.map((d) => {
    const num = numberOf[d];
    if (num) return `- #${num} ${byId[d].title}`;
    return `- ${d} ${byId[d]?.title ?? ''} (tracked elsewhere or not created yet)`;
  });
  return [
    `**Roadmap ID:** ${i.id} · **Area:** ${i.area} · **Priority:** ${i.pri} · **Size:** ${i.size} · **Milestone:** ${i.milestone}`,
    '',
    '## Tasks',
    ...i.tasks.map((t) => `- [ ] ${t}`),
    '',
    '## Acceptance criteria',
    ...i.ac.map((t) => `- [ ] ${t}`),
    ...(deps.length ? ['', '## Depends on', ...deps] : []),
    '',
    '## Definition of done',
    ...dod(i.area).map((t) => `- [ ] ${t}`),
    '',
    `_Reference: CLAUDE.md, ${m.refs}. Seeded from scripts/github/roadmap.mjs._`,
  ].join('\n');
}

const numberOf = {};

console.log(`${dry ? '[dry run] ' : ''}Repo: ${repo}`);
console.log(
  `Issues selected: ${selected.length} of ${all.length}${areaFilter ? ` (areas: ${areaFilter.join(', ')})` : ''}`,
);

// 1. Labels
for (const l of labels) {
  console.log(`label  ${l.name}`);
  if (!dry)
    gh([
      'label',
      'create',
      l.name,
      '--color',
      l.color,
      '--description',
      l.description,
      '--force',
      '--repo',
      repo,
    ]);
}

// 2. Milestones
const due = dueDates(opt('start'));
const existingMs = new Set();
if (!dry) {
  const r = gh([
    'api',
    `repos/${repo}/milestones?state=all&per_page=100`,
    '--paginate',
    '--jq',
    '.[].title',
  ]);
  r.stdout
    .split('\n')
    .filter(Boolean)
    .forEach((t) => existingMs.add(t));
}
const usedMilestones = new Set(selected.map((i) => i.milestone));
for (const m of milestones) {
  if (!usedMilestones.has(m.title)) continue;
  const desc = `${m.goal}\n\nExit criteria: ${m.exit}`;
  if (existingMs.has(m.title)) {
    console.log(`milestone exists: ${m.title}`);
    continue;
  }
  console.log(`milestone ${m.title}${due[m.title] ? ` (due ${due[m.title].slice(0, 10)})` : ''}`);
  if (!dry) {
    const a = [
      'api',
      `repos/${repo}/milestones`,
      '-f',
      `title=${m.title}`,
      '-f',
      `description=${desc}`,
    ];
    if (due[m.title]) a.push('-f', `due_on=${due[m.title]}`);
    const r = gh(a);
    if (r.status !== 0) {
      console.error(r.stderr);
      process.exit(1);
    }
  }
}

// 3. Issues
const existing = {};
if (!dry) {
  const r = gh([
    'issue',
    'list',
    '--repo',
    repo,
    '--state',
    'all',
    '--limit',
    '1000',
    '--json',
    'number,title',
  ]);
  for (const it of JSON.parse(r.stdout || '[]')) {
    const m = /^\[([A-Z]+-\d+)\]/.exec(it.title);
    if (m) existing[m[1]] = it.number;
  }
}
let created = 0;
for (const i of selected) {
  if (existing[i.id]) {
    numberOf[i.id] = existing[i.id];
    console.log(`skip   [${i.id}] exists as #${existing[i.id]}`);
    continue;
  }
  const lbls = [
    `type:${typeOf(i)}`,
    `area:${i.area}`,
    i.pri,
    `size:${i.size}`,
    ...(i.release ? [`release:${i.release}`] : []),
    ...(i.extra ?? []),
  ];
  const title = `[${i.id}] ${i.title}`;
  console.log(`issue  ${title}  (${i.milestone}; ${lbls.join(', ')})`);
  if (dry) continue;
  const r = gh(
    [
      'issue',
      'create',
      '--repo',
      repo,
      '--title',
      title,
      '--body-file',
      '-',
      '--label',
      lbls.join(','),
      '--milestone',
      i.milestone,
    ],
    issueBody(i),
  );
  if (r.status !== 0) {
    console.error(`Failed to create ${title}\n${r.stderr}`);
    process.exit(1);
  }
  const url = r.stdout.trim().split('\n').pop();
  numberOf[i.id] = Number(url.split('/').pop());
  created++;
  sleep(1200);
}
console.log(`${dry ? 'Would create' : 'Created'} ${dry ? selected.length : created} issues.`);
