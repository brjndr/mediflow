import { describe, expect, it } from 'vitest';
import {
  hashPassword,
  MAX_PASSWORD_LENGTH,
  passwordProblem,
  verifyAgainstNothing,
  verifyPassword,
} from './password.js';

describe('password hashing', () => {
  it('stores an Argon2id hash, never the password, and verifies only the right one', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(hash).not.toContain('correct horse');
    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
    expect(await verifyPassword(hash, 'correct horse battery stapler')).toBe(false);
  });

  it('salts each hash, so equal passwords do not produce equal hashes', async () => {
    expect(await hashPassword('the same password')).not.toBe(
      await hashPassword('the same password'),
    );
  });

  it('treats a malformed hash and an over-long password as a mismatch, not an error', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(await verifyPassword('not a hash', 'anything')).toBe(false);
    expect(await verifyPassword(hash, 'x'.repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });

  it('never matches when there is no account to check against', async () => {
    expect(await verifyAgainstNothing('correct horse battery staple')).toBe(false);
  });
});

describe('the rule for a new password', () => {
  it('needs at least 12 characters', () => {
    expect(passwordProblem('elevenchars')).toBe('too_short');
    expect(passwordProblem('twelve chars')).toBeNull();
  });

  it('counts characters as a person sees them', () => {
    // Six emoji are twelve UTF-16 units but six characters.
    expect(passwordProblem('😀😃😄😁😆😅')).toBe('too_short');
  });

  it('refuses a password too long to hash safely', () => {
    expect(passwordProblem('ab3-'.repeat(40))).toBe('too_long');
  });

  it('asks for no particular mix of characters', () => {
    expect(passwordProblem('purple teapot under river')).toBeNull();
    expect(passwordProblem('Tr4verse-Lantern-92')).toBeNull();
  });

  it.each([
    ['one repeated character', 'aaaaaaaaaaaaaa'],
    ['a short repeated pattern', 'abcabcabcabcabc'],
    ['a run of digits', '123456789012'],
    ['a keyboard run', 'qwertyuiopasdf'],
    ['a well-known word', 'MyPassword2026!'],
    ['a well-known word with separators', 'p.a.s.s.w.o.r.d.1.2'],
    ['the product name', 'mediflow-login-1'],
  ])('refuses %s', (_case, password) => {
    expect(passwordProblem(password)).toBe('too_common');
  });

  it("refuses a password built on the user's own email", () => {
    expect(passwordProblem('asha.rao-2026!!', { email: 'asha.rao@hospital.test' })).toBe(
      'too_common',
    );
    expect(passwordProblem('asha.rao-2026!!', { email: 'someone.else@hospital.test' })).toBeNull();
  });
});
