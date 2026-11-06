// Sets up (or removes) an isolated workspace for one issue, so several agents can work at once.
//   node scripts/parallel/worktree.mjs add <issue> <type> <slug>   e.g. add 483 fix invite-resend-cooldown
//   node scripts/parallel/worktree.mjs remove <issue>
// A workspace is a git worktree at ../mediflow-wt/<issue> on branch <type>/<issue>-<slug>, with its
// own installed dependencies and its own test database `mediflow_test_<issue>`, so two agents never
// share files, a branch or test data. Prints the DATABASE_URL_TEST to use for API tests there.
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const [cmd, issue, type, slug] = process.argv.slice(2);
const root = path.resolve(import.meta.dirname, '..', '..');
const dir = path.resolve(root, '..', 'mediflow-wt', String(issue));
const db = `mediflow_test_${issue}`;

const run = (command, args, cwd = root, allowFail = false) => {
  const r = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0 && !allowFail) {
    console.error(`failed: ${command} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
  return r.status === 0;
};
// No shell here: the SQL has spaces and a shell on Windows would split it.
const psql = (sql) =>
  spawnSync(
    'docker',
    ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'mediflow', '-d', 'postgres', '-c', sql],
    { cwd: root, stdio: 'inherit' },
  ).status === 0;

if (!/^\d+$/.test(issue ?? '')) {
  console.error('usage: worktree.mjs add <issue> <feat|fix|chore> <slug> | remove <issue>');
  process.exit(1);
}

if (cmd === 'add') {
  if (!['feat', 'fix', 'chore'].includes(type) || !/^[a-z0-9-]+$/.test(slug ?? '')) {
    console.error('type must be feat, fix or chore; slug kebab-case');
    process.exit(1);
  }
  run('git', ['fetch', 'origin', 'main']);
  run('git', ['worktree', 'add', dir, '-b', `${type}/${issue}-${slug}`, 'origin/main']);
  run('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'], dir);
  psql(`CREATE DATABASE ${db}`); // fails harmlessly when it exists
  console.log(`\nworkspace: ${dir}\nbranch: ${type}/${issue}-${slug}`);
  console.log(
    `API tests there: DATABASE_URL_TEST=postgres://mediflow:mediflow@localhost:5432/${db} pnpm --filter api test <path>`,
  );
} else if (cmd === 'remove') {
  run('git', ['worktree', 'remove', '--force', dir], root, true);
  psql(`DROP DATABASE IF EXISTS ${db}`);
  run('git', ['worktree', 'prune']);
} else {
  console.error('unknown command');
  process.exit(1);
}
