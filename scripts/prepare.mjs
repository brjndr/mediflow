// Installs the git pre-commit hook after `pnpm install`. Skipped in CI and when not in a git checkout.
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

if (process.env.CI || !existsSync('.git')) process.exit(0);
const result = spawnSync('pnpm', ['exec', 'simple-git-hooks'], { stdio: 'inherit', shell: true });
if (result.status !== 0)
  console.warn('simple-git-hooks not installed yet; run `pnpm install` again.');
