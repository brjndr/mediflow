// Server-only: import this module only from server functions / .server code.
import { DatabaseSync } from 'node:sqlite'
import { randomBytes, scryptSync } from 'node:crypto'

export const ROLES = ['admin', 'frontdesk', 'nurse', 'doctor', 'billing'] as const
export type Role = (typeof ROLES)[number]

export { VISIT_STATUSES, type VisitStatus } from '#/lib/visit'

export function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex')
  return `${salt}:${hash}`
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  password_hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  mrn TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dob TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  doctor_id INTEGER NOT NULL REFERENCES users(id),
  scheduled_at TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled',
  vitals TEXT,
  diagnosis TEXT,
  notes TEXT,
  discharge_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS prescriptions (
  id INTEGER PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  drug TEXT NOT NULL,
  dose TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS invoice_items (
  id INTEGER PRIMARY KEY,
  visit_id INTEGER NOT NULL REFERENCES visits(id),
  description TEXT NOT NULL,
  amount_cents INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  user_id INTEGER,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id INTEGER,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
`

function seed(db: DatabaseSync) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get() as { c: number }
  if (count.c > 0) return
  // Demo accounts with FAKE data only. Password for all: "mediflow-demo".
  const pw = 'mediflow-demo'
  const insertUser = db.prepare(
    'INSERT INTO users (username, name, role, password_hash) VALUES (?, ?, ?, ?)',
  )
  insertUser.run('admin', 'Alex Admin', 'admin', hashPassword(pw))
  insertUser.run('frontdesk', 'Fran Frontdesk', 'frontdesk', hashPassword(pw))
  insertUser.run('nurse', 'Nina Nurse', 'nurse', hashPassword(pw))
  insertUser.run('doctor', 'Dr. Dev Doctor', 'doctor', hashPassword(pw))
  insertUser.run('billing', 'Bill Billing', 'billing', hashPassword(pw))
  db.prepare('INSERT INTO patients (mrn, name, dob, phone) VALUES (?, ?, ?, ?)').run(
    'MRN-0001',
    'Sample Patient',
    '1990-01-01',
    '555-0100',
  )
}

const globalForDb = globalThis as unknown as { __mediflowDb?: DatabaseSync }

/** Lazily opened, process-wide SQLite connection. */
export function getDb(): DatabaseSync {
  if (!globalForDb.__mediflowDb) {
    const db = new DatabaseSync(process.env.DATABASE_PATH ?? 'mediflow.db')
    db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;')
    db.exec(SCHEMA)
    seed(db)
    globalForDb.__mediflowDb = db
  }
  return globalForDb.__mediflowDb
}

export function audit(userId: number | null, action: string, entity: string, entityId: number | null) {
  getDb()
    .prepare('INSERT INTO audit_log (user_id, action, entity, entity_id) VALUES (?, ?, ?, ?)')
    .run(userId, action, entity, entityId)
}
