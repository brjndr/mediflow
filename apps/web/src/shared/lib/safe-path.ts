/**
 * Accepts only an address inside this app. Browsers read a backslash as a slash and drop tabs and
 * line breaks, so `/\evil.example` or `/\t/evil.example` mean another site; anything with a
 * backslash (plain or encoded), a control character, or that does not resolve to this origin is
 * refused. Returns the path, or the fallback.
 */
export function safeAppPath(value: unknown, fallback = '/'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//'))
    return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\\\x00-\x1f\x7f]/.test(value) || /%5c/i.test(value)) return fallback;
  try {
    const base = window.location.origin;
    return new URL(value, base).origin === base ? value : fallback;
  } catch {
    return fallback;
  }
}
