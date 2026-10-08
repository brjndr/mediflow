import { queryOptions } from '@tanstack/react-query'

import {
  getDashboardStats,
  getPatient,
  listAppointments,
  listDoctors,
  listPatients,
} from '#/server/hospital.functions'

export const hospitalKeys = {
  patients: ['patients'] as const,
  patient: (id: string) => ['patients', id] as const,
  doctors: ['doctors'] as const,
  appointments: ['appointments'] as const,
  stats: ['stats'] as const,
}

export const patientsQuery = () =>
  queryOptions({
    queryKey: hospitalKeys.patients,
    queryFn: () => listPatients(),
  })

export const patientQuery = (id: string) =>
  queryOptions({
    queryKey: hospitalKeys.patient(id),
    queryFn: () => getPatient({ data: { id } }),
  })

export const doctorsQuery = () =>
  queryOptions({
    queryKey: hospitalKeys.doctors,
    queryFn: () => listDoctors(),
    staleTime: 5 * 60_000,
  })

export const appointmentsQuery = () =>
  queryOptions({
    queryKey: hospitalKeys.appointments,
    queryFn: () => listAppointments(),
  })

export const statsQuery = () =>
  queryOptions({
    queryKey: hospitalKeys.stats,
    queryFn: () => getDashboardStats(),
  })
