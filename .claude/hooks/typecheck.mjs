// Stop hook: run `pnpm typecheck` before Claude finishes. Exit 2 sends errors back to Claude.
// stop_hook_active prevents an endless loop: the hook only blocks once per stop attempt.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
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

const r = spawnSync('pnpm', ['typecheck'], { cwd: root, shell: true, encoding: 'utf8' });
if (r.status === 0) process.exit(0);

const out = `${r.stdout || ''}${r.stderr || ''}`.split('\n').slice(0, 40).join('\n');
process.stderr.write(`pnpm typecheck failed. Fix these errors before finishing:\n${out}\n`);
process.exit(2);
