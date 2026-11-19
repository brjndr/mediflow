// The decision of the dependency audit gate, apart from running pnpm so it can be tested.

const BLOCKING = new Set(['high', 'critical']);

/**
 * `advisories` is the `advisories` object of `pnpm audit --json`; `allowlist` is a list of
 * `{ id, reason, expires }` (id is the GitHub advisory id, expires a YYYY-MM-DD date).
 * Returns the problems that fail the build, as plain lines.
 */
export function auditProblems(advisories, allowlist, today) {
  const problems = [];
  const allowed = new Map();
  for (const entry of allowlist) {
    if (!entry.id || !entry.reason || !/^\d{4}-\d{2}-\d{2}$/.test(entry.expires ?? '')) {
      problems.push(
        `allowlist entry ${entry.id ?? '(no id)'} needs an id, a reason and an expiry date`,
      );
      continue;
    }
    if (entry.expires < today) {
      problems.push(
        `allowlist entry ${entry.id} expired on ${entry.expires}: fix it or renew it with a reason`,
      );
      continue;
    }
    allowed.set(entry.id, entry);
  }
  for (const advisory of Object.values(advisories ?? {})) {
    if (!BLOCKING.has(advisory.severity)) continue;
    if (allowed.has(advisory.github_advisory_id)) continue;
    problems.push(
      `${advisory.severity} ${advisory.github_advisory_id}: ${advisory.module_name} (${advisory.title ?? 'no title'})`,
    );
  }
  return problems;
}
