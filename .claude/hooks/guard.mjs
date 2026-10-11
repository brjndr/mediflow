// PreToolUse guard. Exit code 2 blocks the tool call and sends stderr back to Claude.
// Cross-platform (Node only) so it works on native Windows.
import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();

let input;
try {
  input = JSON.parse(readFileSync(0, 'utf8'));
} catch {
  process.exit(0);
}

const tool = input.tool_name;
const ti = input.tool_input || {};
const cwd = input.cwd || root;

const block = (msg) => {
  process.stderr.write(`Blocked by project guard: ${msg}\n`);
  process.exit(2);
};

const baseName = (p) => String(p).replace(/\\/g, '/').split('/').pop() || '';

const isSecretEnv = (p) => {
  const base = baseName(p);
  if (!/^\.env(\..+)?$/.test(base)) return false;
  return !/\.(example|sample|template)$/.test(base);
};

const isEnvTemplate = (p) => /^\.env(\..+)?\.(example|sample|template)$/.test(baseName(p));

// Commit messages and PR or issue text are not run, so they are not checked. Only text the shell
// cannot expand is dropped: quoted-delimiter heredocs fed to cat, and message flag values with no
// `$` or backtick in them.
const stripMessages = (cmd) =>
  cmd
    .replace(/(cat\s*<<-?\s*(['"])(\w+)\2[^\n]*)\n[\s\S]*?\n[ \t]*\3(?=[\s)"']|$)/g, '$1')
    .replace(
      /(\s(?:-m|--message|--body|--title|--notes)[=\s]\s*)("(?:[^"\\$`]|\\.)*"|'[^']*')/g,
      '$1""',
    );

const segments = (cmd) =>
  cmd
    .split(/&&|\|\||[;|\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const words = (segment) =>
  segment
    .split(/\s+/)
    .filter(Boolean)
    .map((t) => t.replace(/^["']|["']$/g, ''));

// Build output that is safe to delete recursively, anywhere inside the repo.
const BUILD_OUTPUT = new Set(['dist', 'coverage', 'stats.html']);

const isBuildOutput = (target) => {
  const norm = target.replace(/\\/g, '/').replace(/\/+$/, '');
  const parts = norm.split('/');
  if (/[*?$`(){}~<>"']/.test(norm)) return false;
  if (parts.some((p) => p === '..' || p === 'node_modules' || p === '.git')) return false;
  if (!BUILD_OUTPUT.has(parts[parts.length - 1])) return false;
  const rel = path.relative(root, path.resolve(cwd, norm));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
};

const onlyBuildOutput = (segment) => {
  const w = words(segment);
  const at = w.findIndex((t) => /^(rm|rd|rmdir|del|remove-item)$/i.test(t));
  if (at === -1) return false;
  const targets = w
    .slice(at + 1)
    .filter((t) => !/^-/.test(t) && !/^\/[a-z]$/i.test(t) && !/^2>(&1|\/dev\/null|\$null)$/.test(t))
    .flatMap((t) => t.split(','))
    .filter(Boolean);
  return targets.length > 0 && targets.every(isBuildOutput);
};

// The one way to touch a secret .env file: create a missing one from its template.
const isEnvCopy = (segment) => {
  const w = words(segment);
  if (!/^(cp|copy|copy-item)$/i.test(w[0] || '')) return false;
  const args = w.slice(1).filter((t) => !t.startsWith('-'));
  if (args.length !== 2) return false;
  const [from, to] = args;
  return isEnvTemplate(from) && isSecretEnv(to) && !existsSync(path.resolve(cwd, to));
};

// Unknown (no git, no HEAD) counts as committed.
const isCommitted = (abs) => {
  const r = spawnSync('git', ['ls-tree', '--name-only', 'HEAD', '--', path.basename(abs)], {
    cwd: path.dirname(abs),
    encoding: 'utf8',
  });
  return r.status !== 0 || r.stdout.trim() !== '';
};

if (tool === 'Bash') {
  const cmd = stripMessages(String(ti.command || ''));

  const rules = [
    [
      /(?:^|[\s;&|(])(npm|npx|yarn|bun)(?=\s|$)/,
      'Use pnpm only (pnpm install/add/run; pnpm dlx instead of npx).',
    ],
    [/git\s+push\s+[^\n]*(--force\b|--force-with-lease\b|\s-f\b)/, 'Force push is not allowed.'],
    [/git\s+reset\s+--hard/, 'git reset --hard is not allowed.'],
    [/git\s+clean\s+-\w*f/, 'git clean -f is not allowed.'],
    [
      /docker\s+compose\s+down[^\n]*(\s-v\b|--volumes)/,
      'Removing Docker volumes destroys local database data. Ask the user.',
    ],
    [/docker\s+volume\s+(rm|prune)/, 'Removing Docker volumes is not allowed. Ask the user.'],
    [/docker\s+system\s+prune/, 'docker system prune is not allowed.'],
  ];
  for (const [re, msg] of rules) {
    if (re.test(cmd)) block(msg);
  }

  const recursiveDelete = [
    /\brm\s+-\w*[rR]/,
    /Remove-Item[^\n]*-Recurse/i,
    /\b(rd|rmdir|del)\s+[^\n]*\/s\b/i,
  ];
  for (const segment of segments(cmd)) {
    if (recursiveDelete.some((re) => re.test(segment)) && !onlyBuildOutput(segment)) {
      block(
        `Recursive deletion is only allowed for build output (${[...BUILD_OUTPUT].join(', ')}). Delete specific files, or ask the user.`,
      );
    }
    if (words(segment).some(isSecretEnv) && !isEnvCopy(segment)) {
      block(
        'Secret .env files must not be read or modified. A missing one may only be created by copying its .env.example.',
      );
    }
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
    if (/(^|\/)(package-lock\.json|yarn\.lock|bun\.lockb?)$/.test(norm)) {
      block('pnpm only. Never create package-lock.json, yarn.lock or bun.lock.');
    }
    // Migrations are additive: a new file can be edited until it is committed, then never again.
    if (/(^|\/)migrations\//.test(norm)) {
      const abs = path.resolve(cwd, filePath);
      if (existsSync(abs) && isCommitted(abs)) {
        block('Committed migrations are immutable. Add a new migration file instead.');
      }
    }
    if (/(^|\/)\.git\//.test(norm)) block('Do not modify .git internals.');
    if (/(^|\/)node_modules\//.test(norm)) block('Do not edit node_modules.');
  }
}
process.exit(0);
