// Prints the BenchmarkIndex and the TBT median of each audited URL as a Markdown table (#1150).
// It only reports: it never fails, so it changes nothing about what passes. CI appends the output
// to the job summary, to give the numbers a calibration target and a tighter TBT ceiling need.
// Usage: node scripts/lighthouse-summary.mjs <label> [dir ...]   (default dir apps/web/.lighthouseci)
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function* lhrFiles(dir) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* lhrFiles(path);
    else if (/^lhr-.*\.json$/.test(entry.name)) yield path;
  }
}

export function summarize(reports) {
  const seen = new Set();
  const byUrl = new Map();
  for (const lhr of reports) {
    const key = `${lhr.finalUrl}|${lhr.fetchTime}`;
    if (seen.has(key)) continue; // the upload step copies each report into a second folder
    seen.add(key);
    const row = byUrl.get(lhr.finalUrl) ?? { bench: [], tbt: [] };
    if (typeof lhr.environment?.benchmarkIndex === 'number')
      row.bench.push(lhr.environment.benchmarkIndex);
    const tbt = lhr.audits?.['total-blocking-time']?.numericValue;
    if (typeof tbt === 'number') row.tbt.push(tbt);
    byUrl.set(lhr.finalUrl, row);
  }
  return byUrl;
}

export function render(label, byUrl) {
  const lines = [`### Lighthouse runner speed (${label})`, ''];
  if (byUrl.size === 0) return [...lines, 'No Lighthouse reports found.', ''].join('\n');
  lines.push(
    '| URL | Runs | BenchmarkIndex (median) | TBT median (ms) |',
    '| --- | ---: | ---: | ---: |',
  );
  const all = [];
  for (const [url, row] of byUrl) {
    all.push(...row.bench);
    lines.push(
      `| ${url} | ${row.tbt.length} | ${Math.round(median(row.bench) ?? 0)} | ${Math.round(median(row.tbt) ?? 0)} |`,
    );
  }
  lines.push(
    '',
    `BenchmarkIndex of the job: ${Math.round(median(all) ?? 0)} (median of ${all.length} runs).`,
    '',
  );
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [label = 'job', ...dirs] = process.argv.slice(2);
  const reports = [];
  for (const dir of dirs.length ? dirs : ['apps/web/.lighthouseci']) {
    for (const file of lhrFiles(dir)) {
      try {
        reports.push(JSON.parse(readFileSync(file, 'utf8')));
      } catch {
        // a partly written report is skipped
      }
    }
  }
  process.stdout.write(render(label, summarize(reports)));
}
