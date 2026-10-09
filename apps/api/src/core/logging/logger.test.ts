import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { registerErrorHandling } from '../http/errors.js';
import { loggerOptions } from './logger.js';

/** Synthetic patient details. If any of these reaches a log line, a test fails. */
const PATIENT = {
  firstName: 'Asha',
  lastName: 'Verma',
  dob: '1984-03-12',
  phone: '+91 98765 43210',
  mrn: 'MRN-TEST-00042',
  diagnosis: 'Type 2 diabetes',
};
const SECRETS = [...Object.values(PATIENT), 'tok_live_123', 'sessionid=abc', 'hunter2'];

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      lines.push(chunk.toString());
      done();
    },
  });
  return { lines, stream, text: () => lines.join('') };
}

const options = loggerOptions({ LOG_LEVEL: 'info', NODE_ENV: 'production' });

describe('log redaction', () => {
  it('redacts patient fields and secrets at any of three depths', () => {
    const out = capture();
    const log = pino(options, out.stream);

    log.info({ ...PATIENT, password: 'hunter2' }, 'top level');
    log.info({ patient: PATIENT, auth: { token: 'tok_live_123' } }, 'nested once');
    log.info(
      { payload: { patient: PATIENT, headers: { cookie: 'sessionid=abc' } } },
      'nested twice',
    );

    for (const secret of SECRETS) expect(out.text()).not.toContain(secret);
    expect(out.text()).toContain('[redacted]');
    // Non-sensitive fields are still logged.
    log.info({ tenantId: 'tenant_1', status: 200 }, 'safe');
    expect(out.lines.at(-1)).toContain('tenant_1');
  });

  it('is silent under test, so test output stays readable', () => {
    expect(loggerOptions({ LOG_LEVEL: 'info', NODE_ENV: 'test' }).level).toBe('silent');
    expect(loggerOptions({ LOG_LEVEL: 'debug', NODE_ENV: 'production' }).level).toBe('debug');
  });
});

describe('request logging', () => {
  async function requestLog() {
    const out = capture();
    const app = Fastify({ logger: { ...options, stream: out.stream } });
    registerErrorHandling(app);
    app.post('/patients', async () => ({ id: 'pat_1', ...PATIENT }));
    app.get('/boom', async () => {
      throw new Error(`cannot load ${PATIENT.firstName} ${PATIENT.lastName}`);
    });
    return { app, out };
  }

  it('logs the path without the query string, and no request or response body', async () => {
    const { app, out } = await requestLog();
    await app.inject({
      method: 'POST',
      url: `/patients?search=${PATIENT.lastName}&phone=${encodeURIComponent(PATIENT.phone)}`,
      headers: { authorization: 'Bearer tok_live_123', cookie: 'sessionid=abc' },
      payload: PATIENT,
    });
    await app.close();

    expect(out.text()).toContain('"url":"/patients"');
    expect(out.text()).toContain('"statusCode":200');
    for (const secret of SECRETS) expect(out.text()).not.toContain(secret);
    expect(out.text()).not.toContain('search=');
  });

  it('logs an unexpected error by type and stack, without its message', async () => {
    const { app, out } = await requestLog();
    const response = await app.inject({ method: 'GET', url: '/boom' });
    await app.close();

    expect(response.statusCode).toBe(500);
    expect(out.text()).toContain('unhandled error');
    expect(out.text()).toContain('"type":"Error"');
    expect(out.text()).not.toContain(PATIENT.firstName);
    // The client is told nothing about the cause either.
    expect(response.json()).toMatchObject({ error: { code: 'internal' } });
    expect(response.body).not.toContain(PATIENT.firstName);
  });
});
