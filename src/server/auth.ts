// Server-only auth primitives: scrypt passwords, opaque DB-backed sessions, role middleware.
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import { getRequestHeader, setResponseHeader } from '@tanstack/react-start/server'
import { audit, getDb, hashPassword, type Role } from './db'

const COOKIE = 'mediflow_session'
const SESSION_SECONDS = 60 * 60 * 8
const DUMMY_HASH = hashPassword('dummy-password-for-timing')

export type SessionUser = { id: number; username: string; name: string; role: Role }

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

export function verifyPassword(stored: string, password: string) {
  const [salt, hash] = stored.split(':')
  const candidate = scryptSync(password, salt, 64)
  const expected = Buffer.from(hash, 'hex')
  return expected.length === candidate.length && timingSafeEqual(expected, candidate)
}

function cookieAttrs(maxAge: number) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : ''
  return `HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`
}

export function login(username: string, password: string): SessionUser | null {
  const db = getDb()
  const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
    | (SessionUser & { password_hash: string })
    | undefined
  // Always verify (dummy hash for unknown users) so timing doesn't reveal usernames.
  const ok = verifyPassword(row?.password_hash ?? DUMMY_HASH, password)
  if (!row || !ok) {
    audit(null, 'login_failed', 'user', null)
    return null
  }
  // Rotate: drop any existing sessions for this user, then issue a fresh token.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id)
  const token = randomBytes(32).toString('base64url')
  db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(
    sha256(token),
    row.id,
    Math.floor(Date.now() / 1000) + SESSION_SECONDS,
  )
  setResponseHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(SESSION_SECONDS)}`)
  audit(row.id, 'login', 'user', row.id)
  return { id: row.id, username: row.username, name: row.name, role: row.role }
}

function readToken(): string | null {
  const header = getRequestHeader('cookie')
  if (!header) return null
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=')
    if (eq !== -1 && part.slice(0, eq) === COOKIE) return part.slice(eq + 1)
  }
  return null
}

export function currentUser(): SessionUser | null {
  const token = readToken()
  if (!token) return null
  const row = getDb()
    .prepare(
      `SELECT u.id, u.username, u.name, u.role FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(sha256(token), Math.floor(Date.now() / 1000)) as SessionUser | undefined
  return row ?? null
}

export function logout() {
  const token = readToken()
  if (token) getDb().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token))
  setResponseHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`)
}
