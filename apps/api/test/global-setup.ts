import { loadConfig } from '../src/core/config/config.js';
import { runMigrations } from '../src/core/db/migrate.js';

/**
 * Tests run against a real Postgres (the `mediflow_test` database from Docker Compose, or the
 * service container in CI). Start it with `docker compose up -d`.
 */
export default async function setup(): Promise<void> {
  const config = loadConfig({ ...process.env, NODE_ENV: 'test' });
  try {
    await runMigrations(config.DATABASE_URL);
  } catch (error) {
    const reason = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    throw new Error(
      `Cannot prepare the test database. Is Postgres running (docker compose up -d)?\n${reason}`,
      { cause: error },
    );
  }
}
