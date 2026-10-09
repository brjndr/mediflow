import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

/**
 * Applies SQL migrations in order.
 *
 * A migration is one file, `NNNN_what_it_does.sql`, in src/migrations. To add one, create the
 * next numbered file; nothing else is edited. Migrations are additive and immutable: a file that
 * has been applied is never changed, a correction is a new file. The runner enforces this by
 * storing each file's checksum and refusing to continue if an applied file no longer matches.
 *
 * Each file runs in its own transaction with its bookkeeping row, so a failure leaves nothing
 * half-applied. A file whose first line is `-- migrate:no-transaction` runs outside one, for the
 * few statements Postgres does not allow in a transaction (CREATE INDEX CONCURRENTLY).
 */

/** `src/migrations` in development, `dist/migrations` in the built image. */
export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../migrations', import.meta.url));

const FILE_NAME = /^(\d{4})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;
const NO_TRANSACTION = '-- migrate:no-transaction';
/** Arbitrary constant: one runner at a time, however many instances start together. */
const ADVISORY_LOCK = 4_815_162_342;

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Reads and validates the migration files. Throws if the set is not a clean numbered sequence. */
export function readMigrations(folder: string = MIGRATIONS_FOLDER): Migration[] {
  const names = readdirSync(folder)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const migrations: Migration[] = [];
  names.forEach((name, index) => {
    const match = FILE_NAME.exec(name);
    if (!match) {
      throw new MigrationError(`"${name}" is not named NNNN_lower_snake_case.sql.`);
    }
    const expected = String(index + 1).padStart(4, '0');
    if (match[1] !== expected) {
      throw new MigrationError(
        `"${name}" is out of sequence: expected number ${expected}. Numbers are unique and have no gaps.`,
      );
    }
    // Line endings are normalised so a checkout on Windows gives the same checksum.
    const sql = readFileSync(join(folder, name), 'utf8').replace(/\r\n/g, '\n');
    migrations.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  });
  return migrations;
}

/** Applies every pending migration and returns the names it applied. */
export async function runMigrations(
  databaseUrl: string,
  folder: string = MIGRATIONS_FOLDER,
): Promise<string[]> {
  const migrations = readMigrations(folder);
  // One dedicated connection: the lock and the transactions belong to it.
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('select pg_advisory_lock($1)', [ADVISORY_LOCK]);
    await client.query(`
      create table if not exists schema_migrations (
        name text primary key,
        checksum text not null,
        applied_at timestamptz not null default now()
      )`);
    const { rows } = await client.query<{ name: string; checksum: string }>(
      'select name, checksum from schema_migrations',
    );
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));

    for (const name of applied.keys()) {
      if (!migrations.some((migration) => migration.name === name)) {
        throw new MigrationError(`"${name}" was applied to this database but its file is missing.`);
      }
    }

    const done: string[] = [];
    for (const migration of migrations) {
      const recorded = applied.get(migration.name);
      if (recorded !== undefined) {
        if (recorded !== migration.checksum) {
          throw new MigrationError(
            `"${migration.name}" was changed after it was applied. Migrations are immutable: revert the file and add a new migration.`,
          );
        }
        continue;
      }
      // A pending file numbered below an applied one would have been skipped by an earlier run.
      if ([...applied.keys()].some((name) => name > migration.name)) {
        throw new MigrationError(
          `"${migration.name}" is numbered before migrations that are already applied.`,
        );
      }

      const record = 'insert into schema_migrations (name, checksum) values ($1, $2)';
      if (migration.sql.startsWith(NO_TRANSACTION)) {
        await client.query(migration.sql);
        await client.query(record, [migration.name, migration.checksum]);
      } else {
        await client.query('begin');
        try {
          await client.query(migration.sql);
          await client.query(record, [migration.name, migration.checksum]);
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          const reason = error instanceof Error ? error.message : String(error);
          throw new MigrationError(`"${migration.name}" failed and was rolled back: ${reason}`);
        }
      }
      done.push(migration.name);
    }
    return done;
  } finally {
    // Closing the connection releases the advisory lock.
    await client.end();
  }
}
