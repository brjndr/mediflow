import { createServerFn } from '@tanstack/react-start'
import { audit, getDb } from './db'
import type { VisitStatus } from '#/lib/visit'
import { currentUser, login, logout } from './auth'
import { requireRole } from './middleware'

// ---------- input helpers ----------
const obj = (d: unknown): Record<string, unknown> => {
  if (typeof d !== 'object' || d === null) throw new Error('Invalid input')
  return d as Record<string, unknown>
}
const str = (v: unknown, field: string, max = 500, optional = false) => {
  if (typeof v !== 'string') {
    if (optional && v == null) return ''
    throw new Error(`${field} is required`)
  }
  const t = v.trim()
  if (!optional && !t) throw new Error(`${field} is required`)
  if (t.length > max) throw new Error(`${field} is too long`)
  return t
}
const id = (v: unknown, field: string) => {
  const n = Number(v)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${field} is invalid`)
  return n
}

// ---------- types ----------
export type VisitRow = {
  id: number
  patient_id: number
  patient_name: string
  mrn: string
  doctor_id: number
  doctor_name: string
  scheduled_at: string
  reason: string
  status: VisitStatus
  vitals: string | null
  diagnosis: string | null
  notes: string | null
  discharge_summary: string | null
}

const VISIT_SELECT = `
  SELECT v.*, p.name AS patient_name, p.mrn, d.name AS doctor_name
  FROM visits v JOIN patients p ON p.id = v.patient_id JOIN users d ON d.id = v.doctor_id`

function getVisit(visitId: number): VisitRow {
  const v = getDb().prepare(`${VISIT_SELECT} WHERE v.id = ?`).get(visitId) as VisitRow | undefined
  if (!v) throw new Error('Visit not found')
  return v
}

function expectStatus(v: VisitRow, ...allowed: VisitStatus[]) {
  if (!allowed.includes(v.status)) {
    throw new Error(`Visit is "${v.status}"; expected ${allowed.join(' or ')}`)
  }
}

// ---------- auth ----------
export const getSession = createServerFn({ method: 'GET' }).handler(() => currentUser())

export const loginFn = createServerFn({ method: 'POST' })
  .validator((d: unknown) => {
    const o = obj(d)
    return { username: str(o.username, 'Username', 64), password: str(o.password, 'Password', 200) }
  })
  .handler(({ data }) => {
    const user = login(data.username, data.password)
    if (!user) throw new Error('Invalid username or password')
    return user
  })

export const logoutFn = createServerFn({ method: 'POST' }).handler(() => {
  logout()
  return { ok: true }
})

// ---------- reads (any signed-in role) ----------
const anyRole = requireRole()

export const listDoctors = createServerFn({ method: 'GET' })
  .middleware([anyRole])
  .handler(() =>
    getDb().prepare("SELECT id, name FROM users WHERE role = 'doctor' ORDER BY name").all() as {
      id: number
      name: string
    }[],
  )

export const listPatients = createServerFn({ method: 'GET' })
  .middleware([anyRole])
  .handler(
    () =>
      getDb().prepare('SELECT * FROM patients ORDER BY created_at DESC, id DESC').all() as {
        id: number
        mrn: string
        name: string
        dob: string
        phone: string
      }[],
  )

export const listVisits = createServerFn({ method: 'GET' })
  .middleware([anyRole])
  .handler(({ context }) => {
    const u = context.user
    // Doctors only see their own patients' visits.
    if (u.role === 'doctor') {
      return getDb()
        .prepare(`${VISIT_SELECT} WHERE v.doctor_id = ? ORDER BY v.scheduled_at`)
        .all(u.id) as VisitRow[]
    }
    return getDb().prepare(`${VISIT_SELECT} ORDER BY v.scheduled_at`).all() as VisitRow[]
  })

export const getVisitDetail = createServerFn({ method: 'GET' })
  .middleware([anyRole])
  .validator((d: unknown) => ({ visitId: id(obj(d).visitId, 'Visit') }))
  .handler(({ data, context }) => {
    const visit = getVisit(data.visitId)
    if (context.user.role === 'doctor' && visit.doctor_id !== context.user.id) {
      throw new Error('Forbidden: not your patient')
    }
    const db = getDb()
    const prescriptions = db
      .prepare('SELECT * FROM prescriptions WHERE visit_id = ? ORDER BY id')
      .all(visit.id) as { id: number; drug: string; dose: string; instructions: string }[]
    const items = db
      .prepare('SELECT * FROM invoice_items WHERE visit_id = ? ORDER BY id')
      .all(visit.id) as { id: number; description: string; amount_cents: number }[]
    audit(context.user.id, 'view', 'visit', visit.id)
    return { visit, prescriptions, items, total_cents: items.reduce((s, i) => s + i.amount_cents, 0) }
  })

// ---------- 1. register patient (frontdesk) ----------
export const registerPatient = createServerFn({ method: 'POST' })
  .middleware([requireRole('frontdesk')])
  .validator((d: unknown) => {
    const o = obj(d)
    const dob = str(o.dob, 'Date of birth', 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dob)) throw new Error('Date of birth must be YYYY-MM-DD')
    return { name: str(o.name, 'Name', 120), dob, phone: str(o.phone, 'Phone', 32, true) }
  })
  .handler(({ data, context }) => {
    const db = getDb()
    const next = (db.prepare('SELECT COALESCE(MAX(id), 0) + 1 AS n FROM patients').get() as { n: number }).n
    const mrn = `MRN-${String(next).padStart(4, '0')}`
    const r = db
      .prepare('INSERT INTO patients (mrn, name, dob, phone) VALUES (?, ?, ?, ?)')
      .run(mrn, data.name, data.dob, data.phone)
    audit(context.user.id, 'create', 'patient', Number(r.lastInsertRowid))
    return { id: Number(r.lastInsertRowid), mrn }
  })

// ---------- 2. book appointment (frontdesk) ----------
export const bookAppointment = createServerFn({ method: 'POST' })
  .middleware([requireRole('frontdesk')])
  .validator((d: unknown) => {
    const o = obj(d)
    const scheduledAt = str(o.scheduledAt, 'Date/time', 32)
    if (Number.isNaN(Date.parse(scheduledAt))) throw new Error('Date/time is invalid')
    return {
      patientId: id(o.patientId, 'Patient'),
      doctorId: id(o.doctorId, 'Doctor'),
      scheduledAt,
      reason: str(o.reason, 'Reason', 300),
    }
  })
  .handler(({ data, context }) => {
    const db = getDb()
    if (!db.prepare('SELECT 1 FROM patients WHERE id = ?').get(data.patientId)) throw new Error('Patient not found')
    if (!db.prepare("SELECT 1 FROM users WHERE id = ? AND role = 'doctor'").get(data.doctorId)) {
      throw new Error('Doctor not found')
    }
    const r = db
      .prepare('INSERT INTO visits (patient_id, doctor_id, scheduled_at, reason) VALUES (?, ?, ?, ?)')
      .run(data.patientId, data.doctorId, data.scheduledAt, data.reason)
    audit(context.user.id, 'create', 'visit', Number(r.lastInsertRowid))
    return { id: Number(r.lastInsertRowid) }
  })

const visitIdOnly = (d: unknown) => ({ visitId: id(obj(d).visitId, 'Visit') })

function setStatus(visitId: number, status: VisitStatus, userId: number, action: string) {
  getDb().prepare('UPDATE visits SET status = ? WHERE id = ?').run(status, visitId)
  audit(userId, action, 'visit', visitId)
}

// ---------- 3. check in (frontdesk) ----------
export const checkIn = createServerFn({ method: 'POST' })
  .middleware([requireRole('frontdesk')])
  .validator(visitIdOnly)
  .handler(({ data, context }) => {
    expectStatus(getVisit(data.visitId), 'scheduled')
    setStatus(data.visitId, 'checked_in', context.user.id, 'check_in')
    return { ok: true }
  })

export const cancelVisit = createServerFn({ method: 'POST' })
  .middleware([requireRole('frontdesk')])
  .validator(visitIdOnly)
  .handler(({ data, context }) => {
    expectStatus(getVisit(data.visitId), 'scheduled', 'checked_in')
    setStatus(data.visitId, 'cancelled', context.user.id, 'cancel')
    return { ok: true }
  })

// ---------- 4. triage / vitals (nurse) ----------
export const recordVitals = createServerFn({ method: 'POST' })
  .middleware([requireRole('nurse')])
  .validator((d: unknown) => {
    const o = obj(d)
    return { visitId: id(o.visitId, 'Visit'), vitals: str(o.vitals, 'Vitals', 500) }
  })
  .handler(({ data, context }) => {
    expectStatus(getVisit(data.visitId), 'checked_in')
    getDb().prepare('UPDATE visits SET vitals = ? WHERE id = ?').run(data.vitals, data.visitId)
    setStatus(data.visitId, 'triaged', context.user.id, 'record_vitals')
    return { ok: true }
  })

// ---------- 5. consultation: prescribe + conclude (doctor) ----------
function assertOwnVisit(visit: VisitRow, userId: number, role: string) {
  if (role !== 'admin' && visit.doctor_id !== userId) throw new Error('Forbidden: not your patient')
}

export const addPrescription = createServerFn({ method: 'POST' })
  .middleware([requireRole('doctor')])
  .validator((d: unknown) => {
    const o = obj(d)
    return {
      visitId: id(o.visitId, 'Visit'),
      drug: str(o.drug, 'Drug', 120),
      dose: str(o.dose, 'Dose', 120),
      instructions: str(o.instructions, 'Instructions', 300, true),
    }
  })
  .handler(({ data, context }) => {
    const v = getVisit(data.visitId)
    assertOwnVisit(v, context.user.id, context.user.role)
    expectStatus(v, 'triaged')
    const r = getDb()
      .prepare('INSERT INTO prescriptions (visit_id, drug, dose, instructions) VALUES (?, ?, ?, ?)')
      .run(data.visitId, data.drug, data.dose, data.instructions)
    audit(context.user.id, 'prescribe', 'visit', data.visitId)
    return { id: Number(r.lastInsertRowid) }
  })

export const completeConsultation = createServerFn({ method: 'POST' })
  .middleware([requireRole('doctor')])
  .validator((d: unknown) => {
    const o = obj(d)
    return {
      visitId: id(o.visitId, 'Visit'),
      diagnosis: str(o.diagnosis, 'Diagnosis', 300),
      notes: str(o.notes, 'Notes', 4000, true),
    }
  })
  .handler(({ data, context }) => {
    const v = getVisit(data.visitId)
    assertOwnVisit(v, context.user.id, context.user.role)
    expectStatus(v, 'triaged')
    const db = getDb()
    db.prepare('UPDATE visits SET diagnosis = ?, notes = ? WHERE id = ?').run(data.diagnosis, data.notes, data.visitId)
    // Auto-generate the consultation fee line so billing has something to settle.
    db.prepare('INSERT INTO invoice_items (visit_id, description, amount_cents) VALUES (?, ?, ?)').run(
      data.visitId,
      'Consultation fee',
      5000,
    )
    setStatus(data.visitId, 'consulted', context.user.id, 'complete_consultation')
    return { ok: true }
  })

// ---------- 6. billing: add charges, take payment ----------
export const addInvoiceItem = createServerFn({ method: 'POST' })
  .middleware([requireRole('billing')])
  .validator((d: unknown) => {
    const o = obj(d)
    const amount = Number(o.amount)
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1_000_000) throw new Error('Amount is invalid')
    return {
      visitId: id(o.visitId, 'Visit'),
      description: str(o.description, 'Description', 200),
      amountCents: Math.round(amount * 100),
    }
  })
  .handler(({ data, context }) => {
    expectStatus(getVisit(data.visitId), 'consulted')
    getDb()
      .prepare('INSERT INTO invoice_items (visit_id, description, amount_cents) VALUES (?, ?, ?)')
      .run(data.visitId, data.description, data.amountCents)
    audit(context.user.id, 'add_charge', 'visit', data.visitId)
    return { ok: true }
  })

export const markPaid = createServerFn({ method: 'POST' })
  .middleware([requireRole('billing')])
  .validator(visitIdOnly)
  .handler(({ data, context }) => {
    expectStatus(getVisit(data.visitId), 'consulted')
    setStatus(data.visitId, 'paid', context.user.id, 'mark_paid')
    return { ok: true }
  })

// ---------- 7. discharge (frontdesk, requires payment) ----------
export const dischargeVisit = createServerFn({ method: 'POST' })
  .middleware([requireRole('frontdesk')])
  .validator((d: unknown) => {
    const o = obj(d)
    return { visitId: id(o.visitId, 'Visit'), summary: str(o.summary, 'Discharge summary', 1000, true) }
  })
  .handler(({ data, context }) => {
    expectStatus(getVisit(data.visitId), 'paid')
    getDb().prepare('UPDATE visits SET discharge_summary = ? WHERE id = ?').run(data.summary, data.visitId)
    setStatus(data.visitId, 'discharged', context.user.id, 'discharge')
    return { ok: true }
  })
