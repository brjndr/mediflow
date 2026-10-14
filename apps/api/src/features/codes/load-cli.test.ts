import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testConfig } from '../../../test/helpers.js';
import { fileSha256 } from './load.js';

/**
 * The loader as an operator runs it: a process, its arguments, what it prints and how it exits
 * (#316). Its parts are tested in codes.test.ts. It writes into the shared `codes` table of the
 * test database, so its codes are its own (`CLI-`) and are removed at the end.
 */

const CLI = fileURLToPath(new URL('./load-cli.ts', import.meta.url));
const API = fileURLToPath(new URL('../../..', import.meta.url));
const DATABASE_URL = testConfig().DATABASE_URL;

let pool: pg.Pool;
let folder: string;

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the loader as `pnpm --filter api codes:load` does: tsx, from the package's folder. */
function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', CLI, ...args],
      {
        cwd: API,
        // The test database, and the folder the operator is in: a relative path is from there.
        env: { ...process.env, NODE_ENV: 'test', INIT_CWD: folder, ...env },
        timeout: 60_000,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : -1) : 0;
        resolve({ code, stdout, stderr });
      },
    );
  });
}

const file = (name: string, content: string | Uint8Array) => {
  writeFileSync(join(folder, name), content);
  return name;
};

const loads = async (sha256: string) =>
  (
    await pool.query<{ system: string; read: number; added: number; loaded_by: string }>(
      'select system, read, added, loaded_by from code_loads where file_sha256 = $1 order by id',
      [sha256],
    )
  ).rows;

const titleOf = async (code: string) =>
  (
    await pool.query<{ title: string }>(
      "select title from codes where system = 'procedure' and code = $1",
      [code],
    )
  ).rows[0]?.title;

const GOOD = 'code,title\nCLI-1,Loaded from the command\nCLI-2,Loaded from the command too\n';

beforeAll(async () => {
  pool = new pg.Pool({ connectionString: DATABASE_URL });
  folder = mkdtempSync(join(tmpdir(), 'codes-load-'));
  // What a run that was stopped before its end may have left.
  await pool.query("delete from codes where code like 'CLI-%'");
});

describe('the record of the loads', () => {
  it('is out of reach of every role a request or a job runs as', async () => {
    const { rows } = await pool.query<{ role: string; privileges: string[] }>(`
      select role, array(
               select p from unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) as p
               where has_table_privilege(role, 'code_loads', p)
             ) as privileges
      from unnest(array['mediflow_app', 'mediflow_worker', 'mediflow_auth']) as role
      order by role`);
    expect(rows).toEqual([
      { role: 'mediflow_app', privileges: [] },
      { role: 'mediflow_auth', privileges: [] },
      { role: 'mediflow_worker', privileges: [] },
    ]);
  });
});

afterAll(async () => {
  await pool.query("delete from codes where code like 'CLI-%'");
  await pool.query('delete from code_loads where file_sha256 = any($1::text[])', [
    [GOOD, `${GOOD}CLI-3,One more\n`].map((text) => fileSha256(text)),
  ]);
  await pool.end();
  rmSync(folder, { recursive: true, force: true });
});

describe('the code set loader, as a command', () => {
  it('says how it is used, and exits 1, without a set or a file it knows', async () => {
    for (const args of [[], ['--system=icd10'], ['--file=x.csv'], ['--system=loinc', '--file=x']]) {
      const result = await run(args);
      expect(result.code, args.join(' ')).toBe(1);
      expect(result.stderr).toMatch(/^Usage: codes:load --system=<icd10\|procedure> --file=/);
      expect(result.stdout).toBe('');
    }
  });

  it('tries a file with --dry-run, and writes nothing, not even a record', async () => {
    const name = file('dry.csv', GOOD);
    const result = await run(['--system=procedure', `--file=${name}`, '--dry-run']);
    expect(result).toEqual({
      code: 0,
      stdout:
        'procedure: 2 codes read, 2 added, 0 retitled, 0 unchanged. A dry run: nothing was written.\n',
      stderr: '',
    });
    expect(await titleOf('CLI-1')).toBeUndefined();
    expect(await loads(fileSha256(GOOD))).toEqual([]);
  });

  it('loads a file named from where the operator is, and records the load', async () => {
    const name = file('good.csv', GOOD);
    const result = await run(['--system=procedure', `--file=${name}`]);
    expect(result).toEqual({
      code: 0,
      stdout: 'procedure: 2 codes read, 2 added, 0 retitled, 0 unchanged.\n',
      stderr: '',
    });
    expect(await titleOf('CLI-2')).toBe('Loaded from the command too');
    const login = new URL(DATABASE_URL).username;
    expect(await loads(fileSha256(GOOD))).toEqual([
      { system: 'procedure', read: 2, added: 2, loaded_by: login },
    ]);

    // Again, with a code more: the two it has are unchanged, and the load is recorded too.
    const more = `${GOOD}CLI-3,One more\n`;
    const again = await run(['--system=procedure', `--file=${file('more.csv', more)}`]);
    expect(again.stdout).toBe('procedure: 3 codes read, 1 added, 0 retitled, 2 unchanged.\n');
    expect(await loads(fileSha256(more))).toEqual([
      { system: 'procedure', read: 3, added: 1, loaded_by: login },
    ]);
  });

  it('refuses a file it cannot use with a reason that holds nothing of it, and changes nothing', async () => {
    const secret = 'Title that must not be printed';
    const cases: [string, string | Uint8Array, string][] = [
      ['missing.csv', '', 'the file could not be read'],
      [
        'latin1.csv',
        new Uint8Array([...Buffer.from('code,title\nCLI-9,Caf'), 0xe9, 0x0a]),
        'the file is not UTF-8 text',
      ],
      ['header.csv', `name,description\nCLI-9,${secret}\n`, 'line 1:'],
      [
        'code.csv',
        `code,title\nCLI-9,${secret}\nCLI 10,${secret}\n`,
        'line 3: the code is not letters, digits, dots and dashes',
      ],
      [
        'twice.csv',
        `code,title\nCLI-9,${secret}\ncli-9,${secret}\n`,
        'line 3: the code is also on line 2',
      ],
    ];
    for (const [name, content, reason] of cases) {
      if (name !== 'missing.csv') file(name, content);
      const result = await run(['--system=procedure', `--file=${name}`]);
      expect(result.code, name).toBe(1);
      expect(result.stdout, name).toBe('');
      expect(result.stderr, name).toContain(reason);
      expect(result.stderr, name).not.toContain(secret);
      expect(result.stderr, name).not.toContain(folder);
    }
    expect(await titleOf('CLI-9')).toBeUndefined();
  });

  it('gives a database error by its code only, never the connection', async () => {
    const wrong = new URL(DATABASE_URL);
    wrong.password = 'not-the-password';
    const name = file('refused.csv', GOOD);
    const result = await run(['--system=procedure', `--file=${name}`], {
      DATABASE_URL_TEST: wrong.toString(),
    });
    expect(result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Loading failed with database error 28P01. Nothing was changed.\n',
    });

    // A database that cannot be reached is not a database error: it says nothing more.
    const away = new URL(DATABASE_URL);
    away.port = '1';
    const unreachable = await run(['--system=procedure', `--file=${name}`], {
      DATABASE_URL_TEST: away.toString(),
    });
    expect(unreachable).toEqual({
      code: 1,
      stdout: '',
      stderr: 'Loading failed. Nothing was changed.\n',
    });
  });
});
