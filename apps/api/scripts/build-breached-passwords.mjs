// Builds src/core/auth/breached-passwords.txt from a list of leaked passwords, one per line (#1083).
//
//   node scripts/build-breached-passwords.mjs <path to Pwdb_top-1000000.txt>
//
// Source: SecLists, Passwords/Common-Credentials/Pwdb_top-1000000.txt, MIT licence
// (https://github.com/danielmiessler/SecLists). Only entries a new password could be are kept:
// 12 to 128 characters (shorter ones are refused anyway, MIN_PASSWORD_LENGTH), printable, lower
// case as passwordProblem compares them, deduplicated and sorted so a rebuild diffs cleanly.
import { readFileSync, writeFileSync } from 'node:fs';

const input = process.argv[2];
if (!input) {
  process.stderr.write('usage: node scripts/build-breached-passwords.mjs <list>\n');
  process.exit(1);
}

const HEADER = [
  '## Leaked passwords of 12 to 128 characters, lower case, one per line (#1083).',
  '## Built by apps/api/scripts/build-breached-passwords.mjs from SecLists Pwdb_top-1000000.txt.',
  '## SecLists: MIT License, Copyright (c) 2018 Daniel Miessler.',
  '## https://github.com/danielmiessler/SecLists/blob/master/LICENSE',
];

const kept = new Set();
for (const line of readFileSync(input, 'utf8').split(/\r?\n/)) {
  const length = [...line].length;
  if (length < 12 || line.length > 128) continue;
  // Header lines start with "## "; no entry may look like one.
  if (line.startsWith('## ')) continue;
  if (/[\p{Cc}\p{Cf}]/u.test(line) || line.trim() !== line) continue;
  kept.add(line.toLowerCase());
}

const entries = [...kept].sort();
writeFileSync(
  new URL('../src/core/auth/breached-passwords.txt', import.meta.url),
  `${HEADER.join('\n')}\n${entries.join('\n')}\n`,
);
process.stdout.write(`${entries.length} entries\n`);
