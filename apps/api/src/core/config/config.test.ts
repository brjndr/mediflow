import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

const production = {
  NODE_ENV: 'production',
  DATABASE_URL: 'postgres://app:pw@db:5432/hms',
  SMTP_URL: 'smtps://mailer:pw@smtp.example.com:465',
  MAIL_FROM: 'Mediflow <no-reply@example.com>',
  APP_BASE_URL: 'https://app.example.com',
};

describe('loadConfig', () => {
  it('fills defaults and converts numbers', () => {
    expect(loadConfig({ ...production, PORT: '8080' })).toEqual({
      NODE_ENV: 'production',
      HOST: '0.0.0.0',
      PORT: 8080,
      LOG_LEVEL: 'info',
      DATABASE_URL: 'postgres://app:pw@db:5432/hms',
      DATABASE_POOL_MAX: 10,
      SMTP_URL: 'smtps://mailer:pw@smtp.example.com:465',
      MAIL_FROM: 'Mediflow <no-reply@example.com>',
      APP_BASE_URL: 'https://app.example.com',
      SESSION_IDLE_MINUTES: 30,
      SESSION_ABSOLUTE_HOURS: 12,
      SESSION_ROTATE_MINUTES: 15,
      LOGIN_MAX_FAILURES: 5,
      LOGIN_LOCK_MINUTES: 15,
      AUTH_RATE_LIMIT_PER_MINUTE: 10,
      TRUST_PROXY: false,
    });
  });

  it('reads booleans and durations from strings', () => {
    expect(
      loadConfig({ ...production, TRUST_PROXY: 'true', SESSION_IDLE_MINUTES: '10' }),
    ).toMatchObject({ TRUST_PROXY: true, SESSION_IDLE_MINUTES: 10 });
    expect(() => loadConfig({ ...production, SESSION_IDLE_MINUTES: '0' })).toThrow(
      /SESSION_IDLE_MINUTES/,
    );
  });

  it('needs no setup in development: it points at the Docker Compose database', () => {
    const config = loadConfig({});
    expect(config.NODE_ENV).toBe('development');
    expect(config.DATABASE_URL).toBe('postgres://mediflow:mediflow@localhost:5432/mediflow');
    // Mailpit and the Vite dev server.
    expect(config.SMTP_URL).toBe('smtp://localhost:1025');
    expect(config.APP_BASE_URL).toBe('http://localhost:5173');
  });

  it('uses the test database under test, whatever DATABASE_URL says', () => {
    const config = loadConfig({ NODE_ENV: 'test', DATABASE_URL: production.DATABASE_URL });
    expect(config.DATABASE_URL).toMatch(/\/mediflow_test$/);
    expect(
      loadConfig({ NODE_ENV: 'test', DATABASE_URL_TEST: 'postgres://ci:ci@pg:5432/ci_test' })
        .DATABASE_URL,
    ).toBe('postgres://ci:ci@pg:5432/ci_test');
  });

  it('refuses to start in production without its services: nothing local is assumed', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(ConfigError);
    for (const name of ['DATABASE_URL', 'SMTP_URL', 'MAIL_FROM', 'APP_BASE_URL']) {
      expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(new RegExp(name));
      const { [name]: _omitted, ...rest } = production as Record<string, string>;
      expect(() => loadConfig(rest)).toThrow(new RegExp(name));
    }
  });

  it('accepts only an origin as the web app address, so email links cannot carry a path', () => {
    for (const bad of [
      'app.example.com',
      'https://app.example.com/login',
      'https://app.example.com?x=1',
      'ftp://app.example.com',
    ]) {
      expect(() => loadConfig({ ...production, APP_BASE_URL: bad })).toThrow(/APP_BASE_URL/);
    }
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
      loadConfig({
        ...production,
        DATABASE_URL: `mysql://app:${secret}@db/hms`,
        SMTP_URL: `http://mailer:${secret}@smtp.example.com`,
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toMatch(/DATABASE_URL/);
      expect(String(error)).toMatch(/SMTP_URL/);
    }
  });

  it('treats an empty variable as unset', () => {
    expect(loadConfig({ ...production, PORT: '', LOG_LEVEL: '' })).toMatchObject({
      PORT: 3000,
      LOG_LEVEL: 'info',
    });
  });
});
