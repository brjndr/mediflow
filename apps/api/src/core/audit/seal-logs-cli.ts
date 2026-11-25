import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { forkedSeals } from './seal-logs.js';

// Usage: pnpm --filter api audit:seal-logs <log file>   (or pipe the logs in)
// Exits 1 and prints the hospital and seals when two seals follow the same one.
async function main(): Promise<void> {
  const file = process.argv[2];
  const input = file ? createReadStream(file) : process.stdin;
  const lines: string[] = [];
  for await (const line of createInterface({ input })) lines.push(line);
  const forks = forkedSeals(lines);
  for (const fork of forks) process.stdout.write(`${JSON.stringify(fork)}\n`);
  process.stdout.write(forks.length === 0 ? 'no forked seals\n' : `${forks.length} forked\n`);
  process.exitCode = forks.length === 0 ? 0 : 1;
}

void main();
