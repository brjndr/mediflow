// Run with `pnpm --filter api platform:bootstrap --email=<address> --name="<name>"`, or in the
// image with `node dist/core/platform/bootstrap-cli.js`. Needs the API's environment.
//
// Makes the first platform admin of a deployment (or gives one a new set-password link). The link
// is printed once, to this terminal only. The person follows it to choose a password, signs in,
// and sets up an authenticator, which platform routes require.
import { parseArgs } from 'node:util';
import pg from 'pg';
import { loadConfig } from '../config/config.js';
import { BootstrapError, bootstrapPlatformAdmin } from './bootstrap.js';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' } } });

let pool: pg.Pool | undefined;
try {
  if (!values.email || !values.name) {
    throw new BootstrapError('Usage: platform:bootstrap --email=<address> --name="<name>"');
  }
  const config = loadConfig();
  pool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 1 });
  const result = await bootstrapPlatformAdmin(pool, { email: values.email, name: values.name });
  const link = new URL(result.linkPath, config.APP_BASE_URL).toString();
  process.stdout.write(
    `${result.created ? 'Platform admin created.' : 'New link made for the existing platform admin.'}\n` +
      `Open this link within ${result.expiresInHours} hours to choose a password, then set up an authenticator:\n${link}\n`,
  );
} catch (error) {
  // BootstrapError and ConfigError say what to fix and never include connection details.
  const known =
    error instanceof BootstrapError || (error instanceof Error && error.name === 'ConfigError');
  process.stderr.write(
    `${known && error instanceof Error ? error.message : 'Bootstrap failed.'}\n`,
  );
  process.exitCode = 1;
} finally {
  await pool?.end();
}
