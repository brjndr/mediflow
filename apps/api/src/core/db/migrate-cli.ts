// Run with `pnpm --filter api db:migrate` (development) or `node dist/core/db/migrate-cli.js`
// (in the image, before the new version takes traffic).
//
// Two steps: apply pending migrations, then give built-in roles any default permissions they
// have not been offered yet (a feature added since the last deploy). Both are safe to repeat.
import { buildApp } from '../../app.js';
import { syncRoleDefaults } from '../access/sync.js';
import { loadConfig } from '../config/config.js';
import { runMigrations } from './migrate.js';

try {
  const config = loadConfig();
  const applied = await runMigrations(config.DATABASE_URL);
  process.stdout.write(
    applied.length > 0 ? `Applied: ${applied.join(', ')}\n` : 'Nothing to apply.\n',
  );

  // The app is built, not started, to collect the permissions every feature declares.
  const app = await buildApp({ ...config, LOG_LEVEL: 'silent' });
  try {
    await app.ready();
    const granted = await syncRoleDefaults(app.database.pool, app.permissions.all());
    process.stdout.write(`Default role permissions added: ${granted}.\n`);
  } finally {
    await app.close();
  }
} catch (error) {
  // ConfigError and MigrationError name files and rules. Neither includes connection details.
  process.stderr.write(`${error instanceof Error ? error.message : 'Migration failed.'}\n`);
  process.exit(1);
}
