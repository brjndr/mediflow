import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

/**
 * Everything the API reads from its environment, validated once at startup. A missing or
 * malformed value stops the process with every problem listed, instead of surfacing later as a
 * failed request.
 */
const ConfigSchema = Type.Object({
  NODE_ENV: Type.Union(
    [Type.Literal('development'), Type.Literal('test'), Type.Literal('production')],
    { default: 'development' },
  ),
  HOST: Type.String({ minLength: 1, default: '0.0.0.0' }),
  PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3000 }),
  LOG_LEVEL: Type.Union(
    [
      Type.Literal('fatal'),
      Type.Literal('error'),
      Type.Literal('warn'),
      Type.Literal('info'),
      Type.Literal('debug'),
      Type.Literal('trace'),
      Type.Literal('silent'),
    ],
    { default: 'info' },
  ),
  DATABASE_URL: Type.String({ pattern: '^postgres(ql)?://.+' }),
  /** Upper bound on pooled connections. Small, because each request holds one for its duration. */
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  /** Where staff email is handed off, e.g. smtp://user:pass@host:587. */
  SMTP_URL: Type.String({ pattern: '^smtps?://.+' }),
  /** The From header of every email, e.g. `Mediflow <no-reply@example.com>`. */
  MAIL_FROM: Type.String({ minLength: 3 }),
  /** Public address of the web app. Links in emails are built from it, and from nothing else. */
  APP_BASE_URL: Type.String({ pattern: '^https?://[^/?#]+$' }),
});

export type Config = Static<typeof ConfigSchema>;

/**
 * The Docker Compose database from docker-compose.yml. Used only outside production, so local
 * development and tests need no setup. Production must always set DATABASE_URL.
 */
const LOCAL_DATABASE = {
  development: 'postgres://mediflow:mediflow@localhost:5432/mediflow',
  test: 'postgres://mediflow:mediflow@localhost:5432/mediflow_test',
} as const;

/** Mailpit from docker-compose.yml, and the Vite dev server. Never used in production. */
const LOCAL_SERVICES = {
  SMTP_URL: 'smtp://localhost:1025',
  MAIL_FROM: 'Mediflow <no-reply@mediflow.test>',
  APP_BASE_URL: 'http://localhost:5173',
} as const;

export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
  }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env = process.env): Config {
  const mode = env.NODE_ENV ?? 'development';
  // Tests always use the test database, so a developer's own DATABASE_URL is never touched.
  const databaseUrl =
    mode === 'test'
      ? (env.DATABASE_URL_TEST ?? LOCAL_DATABASE.test)
      : (env.DATABASE_URL ?? (mode === 'development' ? LOCAL_DATABASE.development : undefined));

  // Outside production the local services stand in for anything not set. In production these
  // have no default: a missing one stops the process.
  const picked: Record<string, unknown> =
    mode === 'development' || mode === 'test' ? { ...LOCAL_SERVICES } : {};
  if (databaseUrl !== undefined) picked.DATABASE_URL = databaseUrl;
  for (const key of Object.keys(ConfigSchema.properties)) {
    if (key !== 'DATABASE_URL' && env[key] !== undefined && env[key] !== '') picked[key] = env[key];
  }

  // Environment values are strings: fill defaults, then convert "3000" to 3000 where needed.
  const candidate = Value.Convert(ConfigSchema, Value.Default(ConfigSchema, picked));
  if (!Value.Check(ConfigSchema, candidate)) {
    const problems = [...Value.Errors(ConfigSchema, candidate)].map(
      // The value is not echoed: a malformed DATABASE_URL would put a password in the logs.
      (error) => `${error.path.replace(/^\//, '') || 'config'}: ${error.message}`,
    );
    throw new ConfigError([...new Set(problems)]);
  }
  return candidate;
}
