import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/helpers.js';
import { MigrationError, readMigrations, runMigrations } from './migrate.js';

/**
 * The runner is exercised in a scratch database, so its bookkeeping never mixes with the real
 * migrations that global setup applied to the test database.
 */
const adminUrl = testConfig().DATABASE_URL;
const scratchName = `migrate_test_${process.pid}`;
const scratchUrl = adminUrl.replace(/\/[^/]+$/, `/${scratchName}`);
const folders: string[] = [];

function folderWith(files: Record<string, string>): string {
  const folder = mkdtempSync(join(tmpdir(), 'migrations-'));
  folders.push(folder);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(folder, name), sql);
  return folder;
}

async function query<T extends pg.QueryResultRow>(sql: string): Promise<T[]> {
  const client = new pg.Client({ connectionString: scratchUrl });
  await client.connect();
  try {
    return (await client.query<T>(sql)).rows;
  } finally {
    await client.end();
  }
}

async function admin(sql: string) {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  await admin(`drop database if exists ${scratchName}`);
  await admin(`create database ${scratchName}`);
});
afterEach(async () => {
  await query('drop schema public cascade; create schema public;');
});
afterAll(async () => {
  await admin(`drop database if exists ${scratchName}`);
  for (const folder of folders) rmSync(folder, { recursive: true, force: true });
});

const applied = () =>
  query<{ name: string }>('select name from schema_migrations order by name').then((rows) =>
    rows.map((row) => row.name),
  );

describe('runMigrations', () => {
  it('applies pending files in order, once', async () => {
    const folder = folderWith({
      '0001_create_things.sql': 'create table things (id int primary key);',
      '0002_add_label.sql': "alter table things add column label text not null default 'x';",
    });
    expect(await runMigrations(scratchUrl, folder)).toEqual([
      '0001_create_things.sql',
      '0002_add_label.sql',
    ]);
    expect(await applied()).toEqual(['0001_create_things.sql', '0002_add_label.sql']);
    // A second run has nothing to do.
    expect(await runMigrations(scratchUrl, folder)).toEqual([]);
  });

  it('applies only what is new when a file is added later', async () => {
    const first = { '0001_create_things.sql': 'create table things (id int primary key);' };
    await runMigrations(scratchUrl, folderWith(first));
    const next = folderWith({ ...first, '0002_more.sql': 'create table more (id int);' });
    expect(await runMigrations(scratchUrl, next)).toEqual(['0002_more.sql']);
  });

  it('refuses to continue when an applied migration was edited', async () => {
    await runMigrations(
      scratchUrl,
      folderWith({ '0001_create_things.sql': 'create table things (id int primary key);' }),
    );
    const edited = folderWith({
      '0001_create_things.sql': 'create table things (id bigint primary key);',
      '0002_more.sql': 'create table more (id int);',
    });
    await expect(runMigrations(scratchUrl, edited)).rejects.toThrow(
      /"0001_create_things.sql" was changed after it was applied/,
    );
    // Nothing after the edited file ran.
    expect(await applied()).toEqual(['0001_create_things.sql']);
  });

  it('rolls a failing migration back completely and stops', async () => {
    const folder = folderWith({
      '0001_ok.sql': 'create table ok (id int);',
      '0002_broken.sql': 'create table half (id int); select * from does_not_exist;',
      '0003_never.sql': 'create table never (id int);',
    });
    await expect(runMigrations(scratchUrl, folder)).rejects.toThrow(
      /"0002_broken.sql" failed and was rolled back/,
    );
    expect(await applied()).toEqual(['0001_ok.sql']);
    const tables = await query<{ tablename: string }>(
      "select tablename from pg_tables where schemaname = 'public' order by 1",
    );
    // `half` was created inside the failed transaction, so it is gone too.
    expect(tables.map((row) => row.tablename)).toEqual(['ok', 'schema_migrations']);
  });

  it('refuses when an applied migration’s file has been deleted', async () => {
    await runMigrations(
      scratchUrl,
      folderWith({ '0001_a.sql': 'select 1;', '0002_b.sql': 'select 1;' }),
    );
    await expect(
      runMigrations(scratchUrl, folderWith({ '0001_a.sql': 'select 1;' })),
    ).rejects.toThrow(/"0002_b.sql" was applied to this database but its file is missing/);
  });

  it('gives the same checksum whatever the line endings', async () => {
    await runMigrations(scratchUrl, folderWith({ '0001_a.sql': 'select 1;\nselect 2;\n' }));
    await expect(
      runMigrations(scratchUrl, folderWith({ '0001_a.sql': 'select 1;\r\nselect 2;\r\n' })),
    ).resolves.toEqual([]);
  });

  it('runs a marked migration outside a transaction', async () => {
    const folder = folderWith({
      '0001_things.sql': 'create table things (id int);',
      // CREATE INDEX CONCURRENTLY is an error inside a transaction block.
      '0002_index.sql':
        '-- migrate:no-transaction\ncreate index concurrently things_id on things (id);',
    });
    expect(await runMigrations(scratchUrl, folder)).toHaveLength(2);
  });

  it('lets only one runner apply a migration when several start together', async () => {
    const folder = folderWith({ '0001_things.sql': 'create table things (id int);' });
    const results = await Promise.all([
      runMigrations(scratchUrl, folder),
      runMigrations(scratchUrl, folder),
      runMigrations(scratchUrl, folder),
    ]);
    expect(results.flat()).toEqual(['0001_things.sql']);
  });
});

describe('readMigrations', () => {
  it.each([
    ['a name that is not NNNN_snake_case', { '1_first.sql': 'select 1;' }, /is not named/],
    ['capital letters', { '0001_AddThing.sql': 'select 1;' }, /is not named/],
    [
      'a gap in the numbers',
      { '0001_a.sql': 'select 1;', '0003_c.sql': 'select 1;' },
      /"0003_c.sql" is out of sequence: expected number 0002/,
    ],
    [
      'a duplicate number',
      { '0001_a.sql': 'select 1;', '0001_b.sql': 'select 1;' },
      /"0001_b.sql" is out of sequence: expected number 0002/,
    ],
  ])('rejects %s', (_what, files, message) => {
    expect(() => readMigrations(folderWith(files))).toThrow(MigrationError);
    expect(() => readMigrations(folderWith(files))).toThrow(message);
  });

  it('accepts the real migrations', () => {
    const migrations = readMigrations();
    expect(migrations.length).toBeGreaterThanOrEqual(1);
    expect(migrations[0]?.name).toBe('0001_extensions.sql');
  });
});
