import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { loadConfig, type Config } from '../src/core/config/config.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return { ...loadConfig({ ...process.env, NODE_ENV: 'test' }), ...overrides };
}

/** The real app, driven in-process with `app.inject`. Close it when the test file is done. */
export async function buildTestApp(overrides: Partial<Config> = {}): Promise<FastifyInstance> {
  const app = await buildApp(testConfig(overrides));
  await app.ready();
  return app;
}
