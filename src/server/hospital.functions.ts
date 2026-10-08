import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  APPOINTMENT_STATUSES,
  PATIENT_STATUSES,
  appointmentInputSchema,
  patientInputSchema,
} from '#/lib/hospital/schemas'
import { computeStats, getRepo } from './hospital-repo.server'

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
  .handler(async ({ data }) =>
    (await getRepo()).updatePatientStatus(data.id, data.status),
  )

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
  .handler(async ({ data }) =>
    (await getRepo()).updateAppointmentStatus(data.id, data.status),
  )

export const getDashboardStats = createServerFn({ method: 'GET' }).handler(() =>
  computeStats(),
)
