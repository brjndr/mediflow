import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const production = { NODE_ENV: 'production', DATABASE_URL: 'postgres://app:pw@db:5432/hms' };

describe('loadConfig', () => {
  it('fills defaults and converts numbers', () => {
    expect(loadConfig({ ...production, PORT: '8080' })).toEqual({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: 8080,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://app:pw@db:5432/hms',
      DATABASE_POOL_MAX: 10,
    });
  });

  it('needs no setup in development: it points at the Docker Compose database', () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe('development');
    expect(config.DATABASE_URL).toBe('postgres://mediflow:mediflow@localhost:5432/mediflow');
  });

  it('uses the test database under test, whatever DATABASE_URL says', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: production.DATABASE_URL });
    expect(config.DATABASE_URL).toMatch(/\/mediflow_test$/);
    expect(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL_TEST: 'postgres://ci:ci@pg:5432/ci_test' })
        .DATABASE_URL,
    ).toBe('postgres://ci:ci@pg:5432/ci_test');
  });

  it('refuses to start in production without a database', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/DATABASE_URL/);
  });

  it('lists every problem at once', () => {
    let caught: unknown;
    try {
      loadConfig({ ...production, PORT: 'eighty', LOG_LEVEL: 'loud', DATABASE_POOL_MAX: '0' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems.join('\n');
    expect(problems).toMatch(/PORT/);
    expect(problems).toMatch(/LOG_LEVEL/);
    expect(problems).toMatch(/DATABASE_POOL_MAX/);
  });

  it('never echoes a value, which could be a password', () => {
    const secret = 'sup3r-s3cret';
    try {
      loadConfig({ NODE_ENV: 'production', DATABASE_URL: `mysql://app:${secret}@db/hms` });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toMatch(/DATABASE_URL/);
    }
  });

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ ...production, PORT: '', LOG_LEVEL: '' })).toMatchObject({
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });
});
