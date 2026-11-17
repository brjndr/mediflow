// Run with `pnpm --filter api deletion:check`, or in the image with
// `node dist/features/platform/deletion-check-cli.js`. Needs the API's environment.
//
// Connects with DELETION_DATABASE_URL and says whether it is fit to delete a hospital's data.
// Nothing about the connection is printed.
import pg from 'pg';
import { loadConfig } from '../../core/config/config.js';
import { checkDeletionLogin } from './deletion-check.js';

let pool: pg.Pool | undefined;
try {
  const config = loadConfig();
  if (!config.DELETION_DATABASE_URL) {
    throw new Error('DELETION_DATABASE_URL is not set.');
  }
  pool = new pg.Pool({ connectionString: config.DELETION_DATABASE_URL, max: 1 });
  const result = await checkDeletionLogin(pool);
  if (result.ok) {
    process.stdout.write('The deletion login is fit for use.\n');
  } else {
    process.stderr.write(
      `The deletion login is not fit for use:\n- ${result.problems.join('\n- ')}\n`,
    );
    process.exitCode = 1;
  }
} catch (error) {
  const known =
    error instanceof Error && (error.name === 'ConfigError' || /^DELETION_/.test(error.message));
  process.stderr.write(
    `${known && error instanceof Error ? error.message : 'The check failed.'}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
