/**
 * Masks for sensitive values in lists, where the full value is not needed to pick the right row
 * (CLAUDE.md Security and Privacy). The full value is shown on the record itself, to roles
 * allowed to see it.
 */

const DOT = '•';

/** Keeps the last `visible` characters and replaces the rest: `••••••3210`. */
export function maskEnd(value: string, visible = 4): string {
  const text = value.trim();
  if (text.length <= visible) return DOT.repeat(text.length);
  return DOT.repeat(text.length - visible) + text.slice(-visible);
}

/** A phone number with only its last four digits readable. Separators are dropped. */
export function maskPhone(phone: string): string {
  return maskEnd(phone.replace(/[^\d+]/g, ''), 4);
}

/** A medical record number with only its last three characters readable. */
export function maskMrn(mrn: string): string {
  return maskEnd(mrn, 3);
}
