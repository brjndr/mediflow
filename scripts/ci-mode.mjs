// Decides how much of CI a run needs, so the same work is not done twice.
//
//   full    everything (the default, and the answer whenever in doubt)
//   docs    a pull request that changes only Markdown: the format check is enough
//   tested  a push to main whose merge commit has exactly the content of the pull request branch,
//           which the pull request run already tested
//
// In GitHub Actions the mode is written to the step outputs. Expects a checkout with depth 2.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function ciMode({ event, changedFiles = [], mergeTree, branchTree }) {
  if (event === 'pull_request') {
    const docsOnly = changedFiles.length > 0 && changedFiles.every((file) => file.endsWith('.md'));
    return docsOnly ? 'docs' : 'full';
  }
  if (event === 'push' && mergeTree && mergeTree === branchTree) return 'tested';
  return 'full';
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Returns undefined when git cannot answer, which leads to a full run.
  const git = (...args) => {
    const result = spawnSync('git', args, { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : undefined;
  };

  const event = process.env.GITHUB_EVENT_NAME;
  // On a pull request HEAD is the merge of the branch into the base, so its first parent is the base.
  const changed = event === 'pull_request' ? git('diff', '--name-only', 'HEAD^1', 'HEAD') : '';
  const mode = ciMode({
    event,
    changedFiles: changed ? changed.split('\n') : [],
    mergeTree: git('rev-parse', '--verify', '--quiet', 'HEAD^{tree}'),
    // Only a merge commit has a second parent: the head of the merged branch.
    branchTree: git('rev-parse', '--verify', '--quiet', 'HEAD^2^{tree}'),
  });

  console.log(`CI mode: ${mode}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `mode=${mode}\n`);
}
