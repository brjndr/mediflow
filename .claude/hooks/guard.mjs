// PreToolUse guard. Exit code 2 blocks the tool call and sends stderr back to Claude.
// Cross-platform (Node only) so it works on native Windows.
import { readFileSync } from 'node:fs';

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const tool = input.tool_name;
const ti = input.tool_input || {};

const block = (msg) => {
  process.stderr.write(`Blocked by project guard: ${msg}\n`);
  process.exit(2);
};

const isSecretEnv = (p) => {
  const base = String(p).replace(/\\/g, '/').split('/').pop() || '';
  if (!/^\.env(\..+)?$/.test(base)) return false;
  return !/\.(example|sample|template)$/.test(base);
};

if (tool === 'Bash') {
  const cmd = String(ti.command || '');

  const rules = [
    [/(?:^|[\s;&|(])(npm|npx|yarn|bun)(?=\s|$)/, 'Use pnpm only (pnpm install/add/run; pnpm dlx instead of npx).'],
    [/\brm\s+-\w*[rR]/, 'Recursive rm is not allowed. Delete specific files, or ask the user.'],
    [/Remove-Item[^\n]*-Recurse/i, 'Recursive deletion is not allowed. Ask the user.'],
    [/\b(rd|rmdir|del)\s+[^\n]*\/s\b/i, 'Recursive deletion is not allowed. Ask the user.'],
    [/git\s+push\s+[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, 'Force push is not allowed.'],
    [/git\s+reset\s+--hard/, 'git reset --hard is not allowed.'],
    [/git\s+clean\s+-\w*f/, 'git clean -f is not allowed.'],
    [/docker\s+compose\s+down[^\n]*(\s-v\b|--volumes)/, 'Removing Docker volumes destroys local database data. Ask the user.'],
    [/docker\s+volume\s+(rm|prune)/, 'Removing Docker volumes is not allowed. Ask the user.'],
    [/docker\s+system\s+prune/, 'docker system prune is not allowed.'],
  ];
  for (const [re, msg] of rules) {
    if (re.test(cmd)) block(msg);
  }

  const tokens = cmd.split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ''));
  if (tokens.some(isSecretEnv)) {
    block('Secret .env files must not be read or modified. Use .env.example for documentation.');
  }
  process.exit(0);
}

const filePath = ti.file_path || ti.path;
if (filePath) {
  const norm = String(filePath).replace(/\\/g, '/');
  if (isSecretEnv(norm)) {
    block('Secret .env files must not be read or modified. Use .env.example for documentation.');
  }
  if (tool !== 'Read') {
    if (norm.endsWith('/pnpm-lock.yaml') || norm === 'pnpm-lock.yaml') {
      block('Never hand-edit pnpm-lock.yaml. Use pnpm add/remove/install.');
    }
    if (/(^|\/)\.git\//.test(norm)) block('Do not modify .git internals.');
    if (/(^|\/)node_modules\//.test(norm)) block('Do not edit node_modules.');
  }
}
process.exit(0);
