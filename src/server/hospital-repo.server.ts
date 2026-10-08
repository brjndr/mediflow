import { buildSeed } from '#/lib/hospital/seed-data'
import type {
  Appointment,
  AppointmentInput,
  AppointmentStatus,
  ClinicalNote,
  DashboardStats,
  Doctor,
  NoteInput,
  Patient,
  PatientChart,
  PatientInput,
  PatientStatus,
  VitalsInput,
  VitalsReading,
} from '#/lib/hospital/schemas'
import { APPOINTMENT_STATUSES, PATIENT_STATUSES } from '#/lib/hospital/schemas'
import { STAGES, checkTransition, statusAfter } from '#/lib/hospital/workflow'
import type { Stage, StageEvent } from '#/lib/hospital/workflow'

// Placeholder until real auth exists (see AGENTS.md → Known gotchas).
const ACTOR = 'demo-user'

export interface HospitalRepo {
  listPatients: () => Promise<Array<Patient>>
  getPatient: (id: string) => Promise<Patient | null>
  createPatient: (input: PatientInput) => Promise<Patient>
  updatePatientStatus: (id: string, status: PatientStatus) => Promise<Patient>
  getChart: (id: string) => Promise<PatientChart | null>
  /** Persist a (already validated) stage change + its history event. */
  applyTransition: (
    id: string,
    to: Stage,
    status: PatientStatus,
    note?: string,
  ) => Promise<Patient>
  addNote: (input: NoteInput) => Promise<ClinicalNote>
  addVitals: (input: VitalsInput) => Promise<VitalsReading>
  listDoctors: () => Promise<Array<Doctor>>
  listAppointments: () => Promise<Array<Appointment>>
  createAppointment: (input: AppointmentInput) => Promise<Appointment>
  updateAppointmentStatus: (
    id: string,
    status: AppointmentStatus,
  ) => Promise<Appointment>
}

/* -------------------------------------------------------------------------- */
/* In-memory implementation (default; no database required)                   */
/* -------------------------------------------------------------------------- */

function createMemoryRepo(): HospitalRepo {
  const seed = buildSeed()
  const patients = [...seed.patients]
  const doctors = [...seed.doctors]
  const appointments = [...seed.appointments]
  let nextPatient = patients.length + 1
  let nextAppointment = appointments.length + 1
  let nextId = 1
  const newId = (prefix: string) => `${prefix}_${nextId++}`
  const events: Array<StageEvent> = patients.map((p) => ({
    id: newId('e'),
    patientId: p.id,
    from: null,
    to: p.stage,
    at: p.admittedAt,
    by: 'seed',
  }))
  const notes: Array<ClinicalNote> = []
  const vitals: Array<VitalsReading> = []
  const find = (id: string) => {
    const patient = patients.find((p) => p.id === id)
    if (!patient) throw new Error('Patient not found')
    return patient
  }

  return {
    listPatients: () => Promise.resolve([...patients]),
    getPatient: (id) =>
      Promise.resolve(patients.find((p) => p.id === id) ?? null),
    createPatient: (input) => {
      const patient: Patient = {
        ...input,
        id: `p_${String(nextPatient).padStart(3, '0')}`,
        mrn: `MRN-${100200 + nextPatient - 1}`,
        admittedAt: new Date().toISOString(),
        stage: 'REGISTERED',
      }
      nextPatient++
      patients.unshift(patient)
      events.push({
        id: newId('e'),
        patientId: patient.id,
        from: null,
        to: 'REGISTERED',
        at: patient.admittedAt,
        by: ACTOR,
      })
      return Promise.resolve(patient)
    },
    updatePatientStatus: (id, status) => {
      const patient = patients.find((p) => p.id === id)
      if (!patient) return Promise.reject(new Error('Patient not found'))
      patient.status = status
      return Promise.resolve({ ...patient })
    },
    getChart: (id) => {
      const patient = patients.find((p) => p.id === id)
      if (!patient) return Promise.resolve(null)
      const mine = <T extends { patientId: string; at: string }>(
        rows: Array<T>,
      ) =>
        rows
          .filter((r) => r.patientId === id)
          .reverse() // newest-first even when timestamps tie
          .sort((a, b) => b.at.localeCompare(a.at))
      return Promise.resolve({
        patient: { ...patient },
        events: mine(events),
        notes: mine(notes),
        vitals: mine(vitals),
      })
    },
    applyTransition: (id, to, status, note) => {
      const patient = find(id)
      events.push({
        id: newId('e'),
        patientId: id,
        from: patient.stage,
        to,
        at: new Date().toISOString(),
        by: ACTOR,
        note,
      })
      patient.stage = to
      patient.status = status
      return Promise.resolve({ ...patient })
    },
    addNote: (input) => {
      find(input.patientId)
      const note: ClinicalNote = {
        ...input,
        id: newId('n'),
        at: new Date().toISOString(),
        author: ACTOR,
      }
      notes.push(note)
      return Promise.resolve(note)
    },
    addVitals: (input) => {
      find(input.patientId)
      const reading: VitalsReading = {
        ...input,
        id: newId('v'),
        at: new Date().toISOString(),
      }
      vitals.push(reading)
      return Promise.resolve(reading)
    },
    listDoctors: () => Promise.resolve([...doctors]),
    listAppointments: () => Promise.resolve([...appointments]),
    createAppointment: (input) => {
      const appointment: Appointment = {
        ...input,
        id: `a_${String(nextAppointment++).padStart(3, '0')}`,
        status: 'SCHEDULED',
      }
      appointments.push(appointment)
      return Promise.resolve(appointment)
    },
    updateAppointmentStatus: (id, status) => {
      const appointment = appointments.find((a) => a.id === id)
      if (!appointment)
        return Promise.reject(new Error('Appointment not found'))
      appointment.status = status
      return Promise.resolve({ ...appointment })
    },
  }
}

/* -------------------------------------------------------------------------- */
/* Prisma implementation (HOSPITAL_STORAGE=prisma)                            */
/* -------------------------------------------------------------------------- */

async function createPrismaRepo(): Promise<HospitalRepo> {
  // Imported lazily: `#/db` throws at import time when DATABASE_URL is unset.
  const { prisma } = await import('#/db')

  type PatientRow = Awaited<ReturnType<typeof prisma.patient.findFirstOrThrow>>
  type AppointmentRow = Awaited<
    ReturnType<typeof prisma.appointment.findFirstOrThrow>
  >

  const toPatient = (r: PatientRow): Patient => ({
    id: r.id,
    mrn: r.mrn,
    firstName: r.firstName,
    lastName: r.lastName,
    dateOfBirth: r.dateOfBirth.toISOString().slice(0, 10),
    gender: r.gender as Patient['gender'],
    phone: r.phone,
    ward: r.ward as Patient['ward'],
    status: r.status,
    condition: r.condition,
    admittedAt: r.admittedAt.toISOString(),
    stage: r.stage,
  })
  const toAppointment = (r: AppointmentRow): Appointment => ({
    id: r.id,
    patientId: r.patientId,
    doctorId: r.doctorId,
    scheduledAt: r.scheduledAt.toISOString(),
    reason: r.reason,
    status: r.status,
  })

  return {
    listPatients: async () =>
      (await prisma.patient.findMany({ orderBy: { admittedAt: 'desc' } })).map(
        toPatient,
      ),
    getPatient: async (id) => {
      const row = await prisma.patient.findUnique({ where: { id } })
      return row ? toPatient(row) : null
    },
    createPatient: async (input) => {
      const count = await prisma.patient.count()
      const row = await prisma.patient.create({
        data: {
          ...input,
          dateOfBirth: new Date(input.dateOfBirth),
          mrn: `MRN-${100200 + count}-${Date.now().toString(36).toUpperCase()}`,
          stage: 'REGISTERED',
          stageEvents: { create: { toStage: 'REGISTERED', by: ACTOR } },
        },
      })
      return toPatient(row)
    },
    getChart: async (id) => {
      const row = await prisma.patient.findUnique({
        where: { id },
        include: {
          stageEvents: { orderBy: { at: 'desc' } },
          notes: { orderBy: { at: 'desc' } },
          vitals: { orderBy: { at: 'desc' } },
        },
      })
      if (!row) return null
      return {
        patient: toPatient(row),
        events: row.stageEvents.map((e) => ({
          id: e.id,
          patientId: e.patientId,
          from: e.fromStage,
          to: e.toStage,
          at: e.at.toISOString(),
          by: e.by,
          note: e.note ?? undefined,
        })),
        notes: row.notes.map((n) => ({ ...n, at: n.at.toISOString() })),
        vitals: row.vitals.map((v) => ({ ...v, at: v.at.toISOString() })),
      }
    },
    applyTransition: async (id, to, status, note) => {
      const [, row] = await prisma.$transaction(async (tx) => {
        const current = await tx.patient.findUniqueOrThrow({ where: { id } })
        const event = await tx.stageEvent.create({
          data: {
            patientId: id,
            fromStage: current.stage,
            toStage: to,
            by: ACTOR,
            note,
          },
        })
        const updated = await tx.patient.update({
          where: { id },
          data: { stage: to, status },
        })
        return [event, updated] as const
      })
      return toPatient(row)
    },
    addNote: async (input) => {
      const n = await prisma.clinicalNote.create({
        data: { ...input, author: ACTOR },
      })
      return { ...n, at: n.at.toISOString() }
    },
    addVitals: async (input) => {
      const v = await prisma.vitalsReading.create({ data: input })
      return { ...v, at: v.at.toISOString() }
    },
    updatePatientStatus: async (id, status) =>
      toPatient(
        await prisma.patient.update({ where: { id }, data: { status } }),
      ),
    listDoctors: () => prisma.doctor.findMany({ orderBy: { name: 'asc' } }),
    listAppointments: async () =>
      (
        await prisma.appointment.findMany({ orderBy: { scheduledAt: 'asc' } })
      ).map(toAppointment),
    createAppointment: async (input) =>
      toAppointment(
        await prisma.appointment.create({
          data: { ...input, scheduledAt: new Date(input.scheduledAt) },
        }),
      ),
    updateAppointmentStatus: async (id, status) =>
      toAppointment(
        await prisma.appointment.update({ where: { id }, data: { status } }),
      ),
  }
}

/* -------------------------------------------------------------------------- */

declare global {
  var __hospitalRepo: Promise<HospitalRepo> | undefined
}

/**
 * HOSPITAL_STORAGE=memory (default) keeps seeded demo data in process memory
 * so the app runs without Postgres. HOSPITAL_STORAGE=prisma uses DATABASE_URL.
 */
export function getRepo(): Promise<HospitalRepo> {
  globalThis.__hospitalRepo ??=
    process.env.HOSPITAL_STORAGE === 'prisma'
      ? createPrismaRepo()
      : Promise.resolve(createMemoryRepo())
  return globalThis.__hospitalRepo
}

export async function computeStats(): Promise<DashboardStats> {
  const repo = await getRepo()
  const [patients, appointments] = await Promise.all([
    repo.listPatients(),
    repo.listAppointments(),
  ])

  const byStatus = Object.fromEntries(
    PATIENT_STATUSES.map((s) => [s, 0]),
  ) as DashboardStats['byStatus']
  const byStage = Object.fromEntries(
    STAGES.map((s) => [s, 0]),
  ) as DashboardStats['byStage']
  const wardCounts = new Map<string, number>()
  for (const p of patients) {
    byStatus[p.status]++
    byStage[p.stage]++
    wardCounts.set(p.ward, (wardCounts.get(p.ward) ?? 0) + 1)
  }

  const appointmentsByStatus = Object.fromEntries(
    APPOINTMENT_STATUSES.map((s) => [s, 0]),
  ) as DashboardStats['appointmentsByStatus']
  const today = new Date().toDateString()
  let appointmentsToday = 0
  for (const a of appointments) {
    appointmentsByStatus[a.status]++
    if (new Date(a.scheduledAt).toDateString() === today) appointmentsToday++
  }

  return {
    totalPatients: patients.length,
    byStatus,
    byStage,
    byWard: [...wardCounts]
      .map(([ward, count]) => ({ ward, count }))
      .sort((a, b) => b.count - a.count),
    appointmentsToday,
    appointmentsByStatus,
  }
}

/* -------------------------------------------------------------------------- */
/* Workflow service: the rules live here, storage backends stay dumb          */
/* -------------------------------------------------------------------------- */

export async function transitionPatient(
  id: string,
  to: Stage,
  note?: string,
): Promise<Patient> {
  const repo = await getRepo()
  const chart = await repo.getChart(id)
  if (!chart) throw new Error('Patient not found')
  const { patient, vitals, notes } = chart
  const check = checkTransition(patient.stage, to, {
    vitalsCount: vitals.length,
    hasDischargeSummary: notes.some((n) => n.kind === 'DISCHARGE'),
  })
  if (!check.ok) throw new Error(check.reason)
  return repo.applyTransition(id, to, statusAfter(patient.status, to), note)
}

export async function setPatientStatus(
  id: string,
  status: PatientStatus,
): Promise<Patient> {
  const repo = await getRepo()
  const patient = await repo.getPatient(id)
  if (!patient) throw new Error('Patient not found')
  if (patient.stage === 'DISCHARGED' || status === 'DISCHARGED') {
    throw new Error('Use the care workflow to discharge a patient')
  }
  return repo.updatePatientStatus(id, status)
}

/** Checking in for an appointment moves a freshly registered patient to triage. */
export async function setAppointmentStatus(
  id: string,
  status: AppointmentStatus,
): Promise<Appointment> {
  const repo = await getRepo()
  const appointment = await repo.updateAppointmentStatus(id, status)
  if (status === 'CHECKED_IN') {
    const patient = await repo.getPatient(appointment.patientId)
    if (patient?.stage === 'REGISTERED') {
      await transitionPatient(
        patient.id,
        'TRIAGE',
        'Checked in for appointment',
      )
    }
  }
  return appointment
}
