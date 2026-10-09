import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import type pg from 'pg';
import type { Config } from '../config/config.js';

/**
 * The second sign-in factor: a time-based one-time code (TOTP) from an authenticator app, with
 * one-time recovery codes for when the phone is lost.
 *
 * Every function here runs in an auth transaction that has already identified the user, so the
 * database only ever shows this user's own rows.
 */

type MfaConfig = Pick<Config, 'MFA_ENCRYPTION_KEY'>;

/** Shown in the authenticator app next to the account. */
const ISSUER = 'Mediflow';
/** Codes change every 30 seconds. One step either side is accepted, for clocks that disagree. */
const STEP_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;
/** No 0, 1, i, l or o: a recovery code is read off paper and typed. */
const RECOVERY_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

const FORMAT_VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Encrypts an authenticator secret for storage (AES-256-GCM). The user's id is bound in as
 * associated data, so a stored secret copied onto another user's row does not decrypt.
 */
export function encryptSecret(config: MfaConfig, userId: string, secret: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyOf(config), iv);
  cipher.setAAD(Buffer.from(userId));
  const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([FORMAT_VERSION]), iv, cipher.getAuthTag(), encrypted]);
}

/** Throws when the stored value was altered, belongs to another user, or the key is wrong. */
export function decryptSecret(config: MfaConfig, userId: string, stored: Buffer): string {
  if (stored[0] !== FORMAT_VERSION) throw new Error('unknown secret format');
  const iv = stored.subarray(1, 1 + IV_BYTES);
  const tag = stored.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keyOf(config), iv);
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(stored.subarray(1 + IV_BYTES + TAG_BYTES)),
    decipher.final(),
  ]).toString('utf8');
}

function keyOf(config: MfaConfig): Buffer {
  return Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64');
}

/** The step of the code if it is right for this secret now, or null. */
async function matchingStep(secret: string, code: string): Promise<number | null> {
  if (!/^\d{6}$/.test(code)) return null;
  try {
    const result = await verify({ secret, token: code, epochTolerance: STEP_SECONDS });
    return result.valid && 'timeStep' in result ? result.timeStep : null;
  } catch {
    return null;
  }
}

/** Recovery codes are compared without case, spaces or dashes. */
function hashRecoveryCode(code: string): Buffer {
  return createHash('sha256')
    .update(code.toLowerCase().replace(/[^a-z0-9]/g, ''))
    .digest();
}

function newRecoveryCode(): string {
  const characters = Array.from(
    { length: 10 },
    () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)],
  ).join('');
  return `${characters.slice(0, 5)}-${characters.slice(5)}`;
}

interface MfaRow {
  secret_encrypted: Buffer;
  confirmed: boolean;
  last_used_step: string | null;
}

async function lockRow(client: pg.PoolClient, userId: string): Promise<MfaRow | undefined> {
  const { rows } = await client.query<MfaRow>(
    `select secret_encrypted, (confirmed_at is not null) as confirmed, last_used_step
     from user_mfa where user_id = $1 for update`,
    [userId],
  );
  return rows[0];
}

/** Whether sign-in must ask this user for a code. */
export async function isMfaEnabled(client: pg.PoolClient, userId: string): Promise<boolean> {
  const { rowCount } = await client.query(
    'select 1 from user_mfa where user_id = $1 and confirmed_at is not null',
    [userId],
  );
  return rowCount === 1;
}

export interface Enrollment {
  /** Base32, for typing into an authenticator by hand. */
  secret: string;
  /** For the QR code. */
  otpauthUri: string;
}

/**
 * Starts (or restarts) setting up an authenticator. Nothing changes at sign-in until the user
 * proves the authenticator works by confirming a code. Returns null when one is already active.
 */
export async function beginEnrollment(
  client: pg.PoolClient,
  config: MfaConfig,
  user: { id: string; email: string },
): Promise<Enrollment | null> {
  const existing = await lockRow(client, user.id);
  if (existing?.confirmed) return null;

  const secret = generateSecret();
  await client.query(
    `insert into user_mfa (user_id, secret_encrypted) values ($1, $2)
     on conflict (user_id) do update
       set secret_encrypted = excluded.secret_encrypted, last_used_step = null, updated_at = now()`,
    [user.id, encryptSecret(config, user.id, secret)],
  );
  return { secret, otpauthUri: generateURI({ issuer: ISSUER, label: user.email, secret }) };
}

async function replaceRecoveryCodes(client: pg.PoolClient, userId: string): Promise<string[]> {
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await client.query('delete from mfa_recovery_codes where user_id = $1', [userId]);
  await client.query(
    'insert into mfa_recovery_codes (user_id, code_hash) select $1, unnest($2::bytea[])',
    [userId, codes.map(hashRecoveryCode)],
  );
  return codes;
}

/**
 * Finishes setup with a code from the authenticator. Returns the recovery codes, which are shown
 * this once and never again, or null when the code is wrong or there is nothing to confirm.
 */
export async function confirmEnrollment(
  client: pg.PoolClient,
  config: MfaConfig,
  userId: string,
  code: string,
): Promise<string[] | null> {
  const row = await lockRow(client, userId);
  if (!row || row.confirmed) return null;
  const step = await matchingStep(decryptSecret(config, userId, row.secret_encrypted), code);
  if (step === null) return null;
  await client.query(
    'update user_mfa set confirmed_at = now(), last_used_step = $2, updated_at = now() where user_id = $1',
    [userId, step],
  );
  return replaceRecoveryCodes(client, userId);
}

/**
 * Checks an authenticator code for a user whose authenticator is active. A code is accepted
 * once: the same code again, even within its 30 seconds, is refused, so a code read over a
 * shoulder is useless. The row is locked, so two requests with one code cannot both pass.
 */
export async function checkTotp(
  client: pg.PoolClient,
  config: MfaConfig,
  userId: string,
  code: string,
): Promise<boolean> {
  const row = await lockRow(client, userId);
  if (!row?.confirmed) return false;
  const step = await matchingStep(decryptSecret(config, userId, row.secret_encrypted), code);
  if (step === null || (row.last_used_step !== null && step <= Number(row.last_used_step))) {
    return false;
  }
  await client.query(
    'update user_mfa set last_used_step = $2, updated_at = now() where user_id = $1',
    [userId, step],
  );
  return true;
}

/**
 * The second step of sign-in: an authenticator code, or a recovery code, which is used up.
 * Six digits are always an authenticator code.
 */
export async function checkSecondFactor(
  client: pg.PoolClient,
  config: MfaConfig,
  userId: string,
  code: string,
): Promise<boolean> {
  const entered = code.trim();
  if (/^\d{6}$/.test(entered)) return checkTotp(client, config, userId, entered);
  const { rowCount } = await client.query(
    `update mfa_recovery_codes set used_at = now()
     where user_id = $1 and code_hash = $2 and used_at is null`,
    [userId, hashRecoveryCode(entered)],
  );
  return rowCount === 1;
}

/** New recovery codes; the old ones stop working. */
export function regenerateRecoveryCodes(client: pg.PoolClient, userId: string): Promise<string[]> {
  return replaceRecoveryCodes(client, userId);
}

/** Removes the authenticator and its recovery codes. Sign-in is password-only again. */
export async function disableMfa(client: pg.PoolClient, userId: string): Promise<void> {
  await client.query('delete from mfa_recovery_codes where user_id = $1', [userId]);
  await client.query('delete from user_mfa where user_id = $1', [userId]);
}
