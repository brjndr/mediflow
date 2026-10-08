// Fails installs that are not run with pnpm (npm, yarn and bun are not allowed in this repo).
const agent = process.env.npm_config_user_agent || '';
if (!agent.startsWith('pnpm/')) {
  console.error('\nThis repository uses pnpm only. Run: corepack enable && pnpm install\n');
  process.exit(1);
}
