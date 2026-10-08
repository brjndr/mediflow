import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  APPOINTMENT_STATUSES,
  PATIENT_STATUSES,
  appointmentInputSchema,
  noteInputSchema,
  transitionInputSchema,
  vitalsInputSchema,
  patientInputSchema,
} from '#/lib/hospital/schemas'
import {
  computeStats,
  getRepo,
  setAppointmentStatus,
  setPatientStatus,
  transitionPatient,
} from './hospital-repo.server'

// NOTE: server functions are public HTTP endpoints. This demo has no auth;
// see "Known gotchas" in AGENTS.md before handling real patient data.

export const listPatients = createServerFn({ method: 'GET' }).handler(
  async () => (await getRepo()).listPatients(),
)

export const getPatient = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => (await getRepo()).getPatient(data.id))

export const createPatient = createServerFn({ method: 'POST' })
  .validator(patientInputSchema)
  .handler(async ({ data }) => (await getRepo()).createPatient(data))

export const updatePatientStatus = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string(), status: z.enum(PATIENT_STATUSES) }))
  .handler(({ data }) => setPatientStatus(data.id, data.status))

export const getPatientChart = createServerFn({ method: 'GET' })
  .validator(z.object({ id: z.string() }))
  .handler(async ({ data }) => (await getRepo()).getChart(data.id))

export const transitionPatientStage = createServerFn({ method: 'POST' })
  .validator(transitionInputSchema)
  .handler(({ data }) => transitionPatient(data.id, data.to, data.note))

export const addClinicalNote = createServerFn({ method: 'POST' })
  .validator(noteInputSchema)
  .handler(async ({ data }) => (await getRepo()).addNote(data))

export const addVitals = createServerFn({ method: 'POST' })
  .validator(vitalsInputSchema)
  .handler(async ({ data }) => (await getRepo()).addVitals(data))

export const listDoctors = createServerFn({ method: 'GET' }).handler(async () =>
  (await getRepo()).listDoctors(),
)

export const listAppointments = createServerFn({ method: 'GET' }).handler(
  async () => (await getRepo()).listAppointments(),
)

export const createAppointment = createServerFn({ method: 'POST' })
  .validator(appointmentInputSchema)
  .handler(async ({ data }) => (await getRepo()).createAppointment(data))

export const updateAppointmentStatus = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string(), status: z.enum(APPOINTMENT_STATUSES) }))
  .handler(({ data }) => setAppointmentStatus(data.id, data.status))

export const getDashboardStats = createServerFn({ method: 'GET' }).handler(() =>
  computeStats(),
)
