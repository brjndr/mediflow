import { randomBytes } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

/**
 * Passwords are hashed with Argon2id and never stored, logged or compared as text.
 *
 * Parameters follow the OWASP minimum for Argon2id (19 MiB of memory, 2 passes, 1 lane). They
 * are stored inside each hash, so they can be raised later and old hashes still verify.
 */
const ARGON2ID = 2; // The library's Algorithm.Argon2id.
const OPTIONS = { algorithm: ARGON2ID, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const MIN_PASSWORD_LENGTH = 12;
/** Longer input is refused before hashing: hashing megabytes would be a cheap way to tie up the server. */
export const MAX_PASSWORD_LENGTH = 128;

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** True only when the password matches. A malformed hash or an over-long password is a mismatch, never an error. */
export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (password.length > MAX_PASSWORD_LENGTH) return false;
  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

let dummy: Promise<string> | undefined;

/**
 * Spends the same effort as a real verification when there is no account to check against, so
 * the time a failed sign-in takes does not reveal whether the email exists.
 */
export async function verifyAgainstNothing(password: string): Promise<false> {
  dummy ??= hashPassword(randomBytes(24).toString('base64'));
  await verifyPassword(await dummy, password);
  return false;
}

export type PasswordProblem = 'too_short' | 'too_long' | 'too_common';

const COMMON_FRAGMENTS = [
  'password',
  'passw0rd',
  'qwerty',
  'letmein',
  'welcome',
  'mediflow',
  'hospital',
];
const SEQUENCES = [
  '0123456789',
  '9876543210',
  'abcdefghijklmnopqrstuvwxyz',
  'qwertyuiopasdfghjklzxcvbnm',
];

function isSequence(text: string): boolean {
  return SEQUENCES.some((sequence) => (sequence + sequence).includes(text));
}

/**
 * The rule for a new password: at least 12 characters, with no required mix of character types
 * (which pushes people toward predictable patterns), and not one of the obvious choices. Returns
 * what is wrong, or null when the password is acceptable.
 */
export function passwordProblem(
  password: string,
  context: { email?: string } = {},
): PasswordProblem | null {
  // Counted in characters as a person sees them, not UTF-16 units.
  const length = [...password].length;
  if (length < MIN_PASSWORD_LENGTH) return 'too_short';
  if (password.length > MAX_PASSWORD_LENGTH) return 'too_long';

  const lower = password.toLowerCase();
  const letters = lower.replace(/[^a-z]/g, '');
  const localPart = context.email?.toLowerCase().split('@')[0] ?? '';
  const obvious =
    // One character repeated, or two or three alternating.
    new Set(lower).size <= 3 ||
    isSequence(lower) ||
    COMMON_FRAGMENTS.some((fragment) => lower.includes(fragment) || letters.includes(fragment)) ||
    (localPart.length >= 4 && lower.includes(localPart));
  return obvious ? 'too_common' : null;
}
