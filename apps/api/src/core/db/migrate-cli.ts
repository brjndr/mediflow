// Run with `pnpm --filter api db:migrate` (development) or `node dist/core/db/migrate-cli.js`
// (in the image, before the new version takes traffic).
import { loadConfig } from '../config/config.js';
import { runMigrations } from './migrate.js';

try {
  const config = loadConfig();
  const applied = await runMigrations(config.DATABASE_URL);
  process.stdout.write(
    applied.length > 0 ? `Applied: ${applied.join(', ')}\n` : 'Nothing to apply.\n',
  );
} catch (error) {
  // ConfigError and MigrationError name files and rules. Neither includes connection details.
  process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed.'}\n`);
  process.exit(1);
}
