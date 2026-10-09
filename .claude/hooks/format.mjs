// PostToolUse: run Prettier on files Claude edited. Never fails the tool call.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const file = input.tool_input && input.tool_input.file_path;
if (!file || !/\.(ts|tsx|js|jsx|mjs|cjs|css|html|json)$/.test(file)) process.exit(0);
if (/pnpm-lock|package-lock/.test(file)) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
const bin = path.join(
  root,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prettier.cmd' : 'prettier',
);
if (!existsSync(bin)) process.exit(0);

spawnSync('pnpm', ['exec', 'prettier', '--write', `"${file}"`], {
  cwd: root,
  shell: true,
  stdio: 'ignore',
});
process.exit(0);
