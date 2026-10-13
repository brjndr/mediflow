// Loads a code set from a file. Run by an operator, never by a request:
//
//   pnpm --filter api codes:load --system=icd10 --file=/path/to/icd10.csv        (development)
//   node dist/features/codes/load-cli.js --system=icd10 --file=/path/to/icd10.csv   (in the image)
//
// The file is comma-separated text whose first line is `code,title` (see csv.ts). Loading a set
// again adds the codes it has gained and changes the titles that changed; nothing is removed.
// The whole file is checked first and written in one transaction, so a file with a mistake in it
// changes nothing. It connects as the migrating login: the app role cannot write codes.
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { loadConfig } from '../../core/config/config.js';
import { CodeFileError } from './csv.js';
import { loadCodes } from './load.js';
import { CODE_SYSTEMS, type CodeSystem } from './schemas.js';

const argument = (name: string): string | undefined =>
  process.argv
    .slice(2)
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);

const system = CODE_SYSTEMS.find((value) => value === argument('system'));
const file = argument('file');
if (!system || !file) {
  process.stderr.write(
    `Usage: codes:load --system=<${CODE_SYSTEMS.join('|')}> --file=<path to a code,title file>\n`,
  );
  process.exit(1);
}

async function load(set: CodeSystem, path: string): Promise<void> {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    throw new CodeFileError('the file could not be read');
  }
  const client = new pg.Client({ connectionString: loadConfig().DATABASE_URL });
  await client.connect();
  try {
    await client.query('begin');
    const result = await loadCodes(client, set, text);
    await client.query('commit');
    process.stdout.write(
      `${set}: ${result.read} codes read, ${result.added} added, ${result.retitled} retitled, ${result.unchanged} unchanged.\n`,
    );
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

try {
  await load(system, file);
} catch (error) {
  // A CodeFileError names a line and a rule, never a value of the file. Anything else is not
  // printed: a database error can quote the connection.
  process.stderr.write(
    `${error instanceof CodeFileError ? error.message : 'Loading failed. Nothing was changed.'}\n`,
  );
  process.exit(1);
}
