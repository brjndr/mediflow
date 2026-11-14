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
  /**
   * A read replica for reports (`postgres://...`). Unset, reports read from the primary. A replica
   * may lag a little behind the primary, which a report can bear and a bill cannot.
   */
  DATABASE_REPLICA_URL: Type.Optional(Type.String({ pattern: '^postgres(ql)?://.+' })),
  /** Upper bound on pooled connections. Small, because each request holds one for its duration. */
  DATABASE_POOL_MAX: Type.Integer({ minimum: 1, maximum: 100, default: 10 }),
  /** Where staff email is handed off, e.g. smtp://user:pass@host:587. */
  SMTP_URL: Type.String({ pattern: '^smtps?://.+' }),
  /** The From header of every email, e.g. `Mediflow <no-reply@example.com>`. */
  MAIL_FROM: Type.String({ minLength: 3 }),
  /** Public address of the web app. Links in emails are built from it, and from nothing else. */
  APP_BASE_URL: Type.String({ pattern: '^https?://[^/?#]+$' }),
  /** A session unused for this long ends. Per-hospital configuration comes later. */
  SESSION_IDLE_MINUTES: Type.Integer({ minimum: 1, maximum: 1440, default: 30 }),
  /** A session ends this long after sign-in, however active it is. */
  SESSION_ABSOLUTE_HOURS: Type.Integer({ minimum: 1, maximum: 168, default: 12 }),
  /** How often an active session's token is replaced. */
  SESSION_ROTATE_MINUTES: Type.Integer({ minimum: 1, maximum: 1440, default: 15 }),
  /** Failed sign-ins on one account before it is locked for LOGIN_LOCK_MINUTES. */
  LOGIN_MAX_FAILURES: Type.Integer({ minimum: 1, maximum: 100, default: 5 }),
  LOGIN_LOCK_MINUTES: Type.Integer({ minimum: 1, maximum: 1440, default: 15 }),
  /** Sign-in attempts allowed per client address per minute, across all accounts. */
  AUTH_RATE_LIMIT_PER_MINUTE: Type.Integer({ minimum: 1, maximum: 10_000, default: 10 }),
  /**
   * Set when the API runs behind a load balancer or proxy, so the client address comes from the
   * forwarded header. Leave off otherwise: a client could then forge its own address.
   */
  TRUST_PROXY: Type.Boolean({ default: false }),
  /** How long an invitation link works. */
  INVITE_TTL_HOURS: Type.Integer({ minimum: 1, maximum: 720, default: 168 }),
  /** How long a password reset link works. */
  PASSWORD_RESET_TTL_MINUTES: Type.Integer({ minimum: 5, maximum: 1440, default: 30 }),
  /**
   * Encrypts authenticator (TOTP) secrets at rest: 32 random bytes, base64. Generate with
   * `openssl rand -base64 32`. Losing it means every user must set their authenticator up again.
   */
  MFA_ENCRYPTION_KEY: Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' }),
  /**
   * Runs the job queue (pg-boss) and the outbox poller. Off in tests, which drive them by hand.
   * Never off in a deployment: staff email (invitations, password resets) is sent by jobs.
   */
  JOBS_ENABLED: Type.Boolean({ default: true }),
  /** How often pending domain events are handed to the job queue. */
  OUTBOX_POLL_MS: Type.Integer({ minimum: 100, maximum: 60_000, default: 1000 }),
  /** Days a dispatched domain event stays in the outbox before the nightly purge removes it. */
  OUTBOX_RETENTION_DAYS: Type.Integer({ minimum: 1, maximum: 3650, default: 14 }),
  /** Requests one hospital may make per minute, across all its users (noisy-neighbour limit). */
  RATE_LIMIT_TENANT_PER_MINUTE: Type.Integer({ minimum: 1, maximum: 1_000_000, default: 1200 }),
  /** Requests one signed-in user may make per minute. */
  RATE_LIMIT_USER_PER_MINUTE: Type.Integer({ minimum: 1, maximum: 1_000_000, default: 240 }),
  /** How long an Idempotency-Key is remembered. */
  IDEMPOTENCY_TTL_HOURS: Type.Integer({ minimum: 1, maximum: 168, default: 24 }),
  /**
   * How long an event stream may go on sending on its last check of the session and permissions.
   * A burst of events costs one check per stream, not one per event. Tests set 0.
   */
  LIVE_RECHECK_MS: Type.Integer({ minimum: 0, maximum: 30_000, default: 2000 }),
  /**
   * Signs the short-lived download links of report files: 32 random bytes, base64. Generate with
   * `openssl rand -base64 32`. Changing it ends every link already given out.
   */
  REPORT_URL_SECRET: Type.String({ pattern: '^[A-Za-z0-9+/]{43}=$' }),
  /** How long a download link works. */
  REPORT_URL_TTL_SECONDS: Type.Integer({ minimum: 30, maximum: 3600, default: 300 }),
  /** Where the local file store keeps files (report exports), until object storage is used. */
  FILE_STORE_DIR: Type.String({ minLength: 1, default: '.data/files' }),
  /**
   * Where files are kept. `local` is a folder on the API's disk (development and tests);
   * production must use `s3`, since a container loses its disk on redeploy.
   */
  FILE_STORE: Type.Union([Type.Literal('local'), Type.Literal('s3')], { default: 'local' }),
  /** For `s3`: the bucket (private, encrypted at rest, no public access) and its region. */
  S3_BUCKET: Type.Optional(Type.String({ minLength: 3 })),
  S3_REGION: Type.Optional(Type.String({ minLength: 1 })),
  /** For an S3-compatible service other than AWS (MinIO); path-style addressing is then used. */
  S3_ENDPOINT: Type.Optional(Type.String({ pattern: '^https?://' })),
  /** Left out in AWS to use the task or instance role. */
  S3_ACCESS_KEY_ID: Type.Optional(Type.String({ minLength: 1 })),
  S3_SECRET_ACCESS_KEY: Type.Optional(Type.String({ minLength: 1 })),
  /** Asks the service to encrypt each object; leave out when the bucket encrypts by default. */
  S3_SERVER_SIDE_ENCRYPTION: Type.Optional(
    Type.Union([Type.Literal('AES256'), Type.Literal('aws:kms')]),
  ),
  /**
   * For `s3`: hand the browser presigned bucket addresses for uploads and downloads (#765) instead
   * of the API's own links. The bucket then needs a CORS rule for the app's origin, so it is off
   * until that is set up.
   */
  S3_DIRECT_LINKS: Type.Boolean({ default: false }),
  /**
   * What checks uploads for malware. `test` finds only the EICAR test file and is for development
   * and tests; `clamav` talks to a ClamAV daemon (`CLAMAV_HOST`, `CLAMAV_PORT`).
   */
  MALWARE_SCANNER: Type.Union([Type.Literal('test'), Type.Literal('clamav')], { default: 'test' }),
  CLAMAV_HOST: Type.Optional(Type.String({ minLength: 1 })),
  CLAMAV_PORT: Type.Integer({ minimum: 1, maximum: 65535, default: 3310 }),
  CLAMAV_TIMEOUT_MS: Type.Integer({ minimum: 1000, maximum: 300_000, default: 60_000 }),
  /** A report answered on the spot gives up after this long, so it cannot hold a connection. */
  REPORT_SYNC_TIMEOUT_MS: Type.Integer({ minimum: 1000, maximum: 60_000, default: 10_000 }),
  /** A report made by a job gives up after this long. */
  REPORT_RUN_TIMEOUT_MS: Type.Integer({ minimum: 1000, maximum: 600_000, default: 120_000 }),
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
  // Thirty-two zero bytes. It protects nothing, and production has no default.
  MFA_ENCRYPTION_KEY: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  // Also thirty-two zero bytes: links signed with it are forgeable, so production has no default.
  REPORT_URL_SECRET: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
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
  // The all-zero key is the development default: links signed with it can be forged by anyone.
  if (mode === 'production' && candidate.REPORT_URL_SECRET === LOCAL_SERVICES.REPORT_URL_SECRET) {
    throw new ConfigError(['REPORT_URL_SECRET: the development key cannot be used in production']);
  }
  if (mode === 'production' && candidate.MALWARE_SCANNER !== 'clamav') {
    throw new ConfigError([
      'MALWARE_SCANNER: production must use clamav, the test scanner finds only EICAR',
    ]);
  }
  if (candidate.MALWARE_SCANNER === 'clamav' && !candidate.CLAMAV_HOST) {
    throw new ConfigError(['CLAMAV_HOST: required when MALWARE_SCANNER is clamav']);
  }
  if (candidate.FILE_STORE === 's3' || mode === 'production') {
    const problems: string[] = [];
    if (mode === 'production' && candidate.FILE_STORE !== 's3') {
      problems.push('FILE_STORE: production must use s3, the local folder is lost on redeploy');
    }
    if (candidate.FILE_STORE === 's3') {
      if (!candidate.S3_BUCKET) problems.push('S3_BUCKET: required when FILE_STORE is s3');
      if (!candidate.S3_REGION) problems.push('S3_REGION: required when FILE_STORE is s3');
    }
    if (!candidate.S3_ACCESS_KEY_ID !== !candidate.S3_SECRET_ACCESS_KEY) {
      problems.push('S3_ACCESS_KEY_ID: give both keys or neither');
    }
    if (problems.length > 0) throw new ConfigError(problems);
  }
  return candidate;
}
