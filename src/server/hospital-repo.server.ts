import { buildSeed } from '#/lib/hospital/seed-data'
import type {
  Appointment,
  AppointmentInput,
  AppointmentStatus,
  DashboardStats,
  Doctor,
  Patient,
  PatientInput,
  PatientStatus,
} from '#/lib/hospital/schemas'
import { APPOINTMENT_STATUSES, PATIENT_STATUSES } from '#/lib/hospital/schemas'

export interface HospitalRepo {
  listPatients: () => Promise<Array<Patient>>
  getPatient: (id: string) => Promise<Patient | null>
  createPatient: (input: PatientInput) => Promise<Patient>
  updatePatientStatus: (id: string, status: PatientStatus) => Promise<Patient>
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
      }
      nextPatient++
      patients.unshift(patient)
      return Promise.resolve(patient)
    },
    updatePatientStatus: (id, status) => {
      const patient = patients.find((p) => p.id === id)
      if (!patient) return Promise.reject(new Error('Patient not found'))
      patient.status = status
      return Promise.resolve({ ...patient })
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
        },
      })
      return toPatient(row)
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
  const wardCounts = new Map<string, number>()
  for (const p of patients) {
    byStatus[p.status]++
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
    byWard: [...wardCounts]
      .map(([ward, count]) => ({ ward, count }))
      .sort((a, b) => b.count - a.count),
    appointmentsToday,
    appointmentsByStatus,
  }
}
