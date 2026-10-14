// One-time update (#337): adds the accessibility line to the definition of done of every open
// issue that lacks it. roadmap.mjs only reaches issues seeded after it changed.
// Dry run by default; --apply edits the issues. Safe to re-run: an issue with the line is skipped.
//
// Usage:
//   node scripts/github/add-dod-line.mjs [--repo owner/name]
//   node scripts/github/add-dod-line.mjs --apply [--repo owner/name]
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { A11Y_DOD } from './roadmap.mjs';

const HEADING = /^##\s+Definition of done\s*$/i;
const ITEM = /^\s*- \[[ xX]\]/;

/** The body with the line added, or null when it already has it. */
export function withDodLine(body, line = A11Y_DOD) {
  const text = body ?? '';
  if (text.includes(line)) return null;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const item = `- [ ] ${line}`;
  const at = lines.findIndex((l) => HEADING.test(l));
  if (at < 0) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    return [...lines, '', '## Definition of done', item, ''].join(eol);
  }
  // After the last checklist item of the section, or right under the heading if it has none.
  let insertAt = at + 1;
  for (let i = at + 1; i < lines.length && !/^#{1,2}\s/.test(lines[i]) && lines[i] !== '---'; i++)
    if (ITEM.test(lines[i])) insertAt = i + 1;
  lines.splice(insertAt, 0, item);
  return lines.join(eol);
}

function gh(args, input) {
  const r = spawnSync('gh', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) {
    console.error('The GitHub CLI (gh) was not found. Install it and run: gh auth login');
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(r.stderr);
    process.exit(1);
  }
  return r.stdout;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const repoAt = args.indexOf('--repo');
  const repo =
    repoAt >= 0
      ? args[repoAt + 1]
      : JSON.parse(gh(['repo', 'view', '--json', 'nameWithOwner'])).nameWithOwner;
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '1000',
      '--json',
      'number,title,body',
    ]),
  );
  let changed = 0;
  for (const issue of issues) {
    const body = withDodLine(issue.body);
    if (body === null) continue;
    changed++;
    console.log(`${apply ? 'update' : 'would update'}  #${issue.number} ${issue.title}`);
    if (apply)
      gh(['issue', 'edit', String(issue.number), '--repo', repo, '--body-file', '-'], body);
  }
  console.log(
    `${apply ? 'Updated' : '[dry run] Would update'} ${changed} of ${issues.length} open issues.`,
  );
}
