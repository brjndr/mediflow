// Loads a code set from a file. Run by an operator, never by a request:
//
//   pnpm --filter api codes:load --system=icd10 --file=/path/to/icd10.csv        (development)
//   node dist/features/codes/load-cli.js --system=icd10 --file=/path/to/icd10.csv   (in the image)
//
// The file is comma-separated UTF-8 text whose first line is `code,title` (see csv.ts). Loading a
// set again adds the codes it has gained and changes the titles that changed; nothing is removed,
// so try a file first with `--dry-run`, which says what it would do and writes nothing. The whole
// file is checked first and written in one transaction, so a file with a mistake in it changes
// nothing. A load that is written leaves a row in `code_loads` (the set, the file's SHA-256, the
// counts, when and as which login); a dry run leaves none. It connects as the migrating login, with the environment of the migrate step: the app
// role cannot write codes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';
import { ConfigError, loadConfig } from '../../core/config/config.js';
import { CodeFileError } from './csv.js';
import { decodeCodeFile, fileSha256, loadCodes } from './load.js';
import { CODE_SYSTEMS, type CodeSystem } from './schemas.js';

const args = process.argv.slice(2);
const argument = (name: string): string | undefined =>
  args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

const system = CODE_SYSTEMS.find((value) => value === argument('system'));
const file = argument('file');
const dryRun = args.includes('--dry-run');
if (!system || !file) {
  process.stderr.write(
    `Usage: codes:load --system=<${CODE_SYSTEMS.join('|')}> --file=<path to a code,title file> [--dry-run]\n`,
  );
  process.exit(1);
}

async function load(set: CodeSystem, path: string): Promise<void> {
  let bytes: Uint8Array;
  try {
    // pnpm runs a script in the package's folder: a relative path is from where the operator is.
    bytes = readFileSync(resolve(process.env.INIT_CWD ?? process.cwd(), path));
  } catch {
    throw new CodeFileError('the file could not be read');
  }
  const text = decodeCodeFile(bytes);
  const client = new pg.Client({ connectionString: loadConfig().DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    const result = await loadCodes(client, set, text, fileSha256(bytes));
    await client.query(dryRun ? 'rollback' : 'commit');
    process.stdout.write(
      `${set}: ${result.read} codes read, ${result.added} added, ${result.retitled} retitled, ${result.unchanged} unchanged.${dryRun ? ' A dry run: nothing was written.' : ''}\n`,
    );
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

/** What went wrong, in words that hold nothing of the file or of the connection. */
function reason(error: unknown): string {
  // A CodeFileError names a line and a rule, a ConfigError the variables that are wrong.
  if (error instanceof CodeFileError || error instanceof ConfigError) return error.message;
  // A database error can quote the connection or a row, so only its code is given: 42501 is a
  // login that may not write codes (use the migrating one), 28P01 a wrong password.
  if (error instanceof pg.DatabaseError && error.code) {
    return `Loading failed with database error ${error.code}. Nothing was changed.`;
  }
  return 'Loading failed. Nothing was changed.';
}

try {
  await load(system, file);
} catch (error) {
  process.stderr.write(`${reason(error)}\n`);
  process.exit(1);
}
