import { describe, expect, it } from 'vitest';
import { checkDeletionLogin } from './deletion-check.js';

const client = (row: object | undefined) =>
  ({ query: async () => ({ rows: row ? [row] : [] }) }) as never;
const good = { is_super: false, version_num: 160000, login: 'del', roles: ['mediflow_deletion'] };

describe('checkDeletionLogin', () => {
  it('accepts a login that only belongs to mediflow_deletion', async () => {
    expect(await checkDeletionLogin(client(good))).toEqual({ ok: true, problems: [] });
  });

  it('refuses a superuser, an old server, a missing or extra role', async () => {
    const bad = await checkDeletionLogin(
      client({ ...good, is_super: true, version_num: 140000, roles: ['other'] }),
    );
    expect(bad.ok).toBe(false);
    expect(bad.problems).toHaveLength(4);
    expect(
      (await checkDeletionLogin(client({ ...good, roles: ['mediflow_deletion', 'x'] }))).ok,
    ).toBe(false);
    expect((await checkDeletionLogin(client(undefined))).ok).toBe(false);
  });
});
