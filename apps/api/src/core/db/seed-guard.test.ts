import { describe, expect, it } from 'vitest';
import { seedDecision } from './seed-guard.js';

const url = (host: string) => `postgres://app:not-a-real-secret@${host}:5432/mediflow`;

describe('where the development seed may run', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', 'postgres', 'LOCALHOST'])(
    'runs against a database on this machine (%s)',
    (host) => {
      expect(seedDecision(url(host), 'development')).toEqual({ allowed: true });
    },
  );

  it('never runs in production, wherever the database is', () => {
    expect(seedDecision(url('localhost'), 'production').allowed).toBe(false);
    expect(seedDecision(url('db.internal'), 'production', 'db.internal').allowed).toBe(false);
  });

  it('refuses a database that is not on this machine, even with NODE_ENV unset to development', () => {
    const decision = seedDecision(url('prod-db.ap-south-1.rds.amazonaws.com'), 'development');

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('prod-db.ap-south-1.rds.amazonaws.com');
    // The message is printed to a terminal: nothing of the credentials goes into it.
    expect(decision.reason).not.toContain('not-a-real-secret');
    expect(decision.reason).not.toContain('app:');
  });

  it('runs against another host only when that exact host is named', () => {
    const staging = url('staging-db.example.test');

    expect(seedDecision(staging, 'development', 'staging-db.example.test').allowed).toBe(true);
    expect(seedDecision(staging, 'development', 'STAGING-DB.example.test').allowed).toBe(true);
    expect(seedDecision(staging, 'development', 'other-db.example.test').allowed).toBe(false);
    expect(seedDecision(staging, 'development', '').allowed).toBe(false);
    expect(seedDecision(staging, 'development', '*').allowed).toBe(false);
  });

  it('refuses an address it cannot read', () => {
    expect(seedDecision('not a url', 'development').allowed).toBe(false);
  });
});
