// Helpers for scripts/zap-serve.mjs (#1082), kept apart so the tests can import them.

/**
 * Reads a `_headers` file (Netlify / Cloudflare Pages format): a path pattern at the start of a
 * line, then its headers indented below it. `#` starts a comment. Returns the rules in file order.
 */
export function parseHeadersFile(text) {
  const rules = [];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    if (!/^\s/.test(raw)) {
      current = { pattern: raw.trim(), headers: {} };
      rules.push(current);
      continue;
    }
    const colon = raw.indexOf(':');
    if (!current || colon === -1) continue;
    current.headers[raw.slice(0, colon).trim()] = raw.slice(colon + 1).trim();
  }
  return rules;
}

/** `/*` matches everything; `/assets/*` everything below it; anything else matches exactly. */
function matches(pattern, path) {
  if (pattern.endsWith('*')) return path.startsWith(pattern.slice(0, -1));
  return path === pattern;
}

/** The headers a host would send for `path`: every matching rule, later ones overriding. */
export function headersFor(rules, path) {
  const result = {};
  for (const rule of rules) if (matches(rule.pattern, path)) Object.assign(result, rule.headers);
  return result;
}
