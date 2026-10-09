// Stop hook: run `pnpm typecheck` before Claude finishes. Exit 2 sends errors back to Claude.
// stop_hook_active prevents an endless loop: the hook only blocks once per stop attempt.
// The run is skipped when nothing type-relevant changed since the last passing run
// (fingerprint of HEAD plus changed and untracked TS/config files), so Q&A turns stay fast.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

let input = {};
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  /* no input */
}
if (input.stop_hook_active) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const pkgPath = path.join(root, 'package.json');
if (!existsSync(pkgPath) || !existsSync(path.join(root, 'node_modules'))) process.exit(0);

let scripts = {};
try {
  scripts = JSON.parse(readFileSync(pkgPath, 'utf8')).scripts || {};
} catch {
  process.exit(0);
}
if (!scripts.typecheck) process.exit(0);

const git = (...args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
};

const RELEVANT = /\.(ts|tsx|mts|cts)$|(^|\/)(tsconfig[^/]*\.json|package\.json|pnpm-lock\.yaml)$/;

// Returns null when git is unavailable, which means "always run".
const fingerprint = () => {
  const head = git('rev-parse', 'HEAD');
  const changed = git('diff', 'HEAD', '--name-only');
  const untracked = git('ls-files', '--others', '--exclude-standard');
  if (head === null || changed === null || untracked === null) return null;
  const hash = createHash('sha1').update(head);
  const files = [
    ...new Set(`${changed}\n${untracked}`.split('\n').filter((f) => RELEVANT.test(f))),
  ];
  for (const f of files.sort()) {
    let stamp = 'deleted';
    try {
      const s = statSync(path.join(root, f));
      stamp = `${s.mtimeMs}:${s.size}`;
    } catch {
      /* deleted */
    }
    hash.update(`${f}=${stamp}\n`);
  }
  return hash.digest('hex');
};

const stampFile = path.join(root, 'node_modules', '.cache', 'claude-typecheck.stamp');
const before = fingerprint();
if (before && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === before) process.exit(0);

const r = spawnSync('pnpm', ['typecheck'], { cwd: root, shell: true, encoding: 'utf8' });
if (r.status === 0) {
  if (before) {
    try {
      mkdirSync(path.dirname(stampFile), { recursive: true });
      writeFileSync(stampFile, before);
    } catch {
      /* cache is best-effort */
    }
  }
  process.exit(0);
}

const out = `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(0, 40).join('\n');
process.stderr.write(`pnpm typecheck failed. Fix these errors before finishing:\n${out}\n`);
process.exit(2);
