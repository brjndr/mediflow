import type pg from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { withTenantTransaction } from './transaction.js';

/** A pool whose one connection fails the statements `failOn` matches. */
function fakePool(failOn: (sql: string) => boolean) {
  const statements: string[] = [];
  const release = vi.fn();
  const client = {
    query: vi.fn((sql: string) => {
      statements.push(sql);
      return failOn(sql)
        ? Promise.reject(new Error(`failed: ${sql}`))
        : Promise.resolve({ rows: [] });
    }),
    release,
  };
  const pool = { connect: () => Promise.resolve(client) } as unknown as pg.Pool;
  return { pool, statements, release };
}

describe('withTenantTransaction', () => {
  it('binds the hospital under the app role, commits and gives the connection back once', async () => {
    const { pool, statements, release } = fakePool(() => false);
    await expect(withTenantTransaction(pool, 't1', () => Promise.resolve(7))).resolves.toBe(7);
    expect(statements[0]).toBe('begin');
    expect(statements[1]).toMatch(/^set local role /);
    expect(statements.at(-1)).toBe('commit');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('rolls back on a failure and returns the healthy connection to the pool', async () => {
    const { pool, statements, release } = fakePool(() => false);
    await expect(
      withTenantTransaction(pool, 't1', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(statements.at(-1)).toBe('rollback');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(undefined);
  });

  it('destroys the connection when the rollback fails, and still throws the original error', async () => {
    const { pool, release } = fakePool((sql) => sql === 'rollback');
    await expect(
      withTenantTransaction(pool, 't1', () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it('begins read only with a statement timeout when asked', async () => {
    const { pool, statements } = fakePool(() => false);
    await withTenantTransaction(pool, 't1', () => Promise.resolve(), {
      readOnly: true,
      statementTimeoutMs: 5000,
    });
    expect(statements[0]).toBe('begin read only');
    expect(statements).toContain("select set_config('statement_timeout', $1, true)");
  });
});
