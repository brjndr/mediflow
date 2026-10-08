import { z } from 'zod'

export const PATIENT_STATUSES = [
  'ADMITTED',
  'OUTPATIENT',
  'CRITICAL',
  'DISCHARGED',
] as const
export const APPOINTMENT_STATUSES = [
  'SCHEDULED',
  'CHECKED_IN',
  'COMPLETED',
  'CANCELLED',
] as const
export const WARDS = [
  'Emergency',
  'Cardiology',
  'Neurology',
  'Pediatrics',
  'Oncology',
  'Orthopedics',
  'Maternity',
  'ICU',
] as const
export const GENDERS = ['Female', 'Male', 'Other'] as const

export type PatientStatus = (typeof PATIENT_STATUSES)[number]
export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number]
export type Ward = (typeof WARDS)[number]

export const patientInputSchema = z.object({
  firstName: z
    .string()
    .trim()
    .min(2, 'First name must be at least 2 characters'),
  lastName: z.string().trim().min(2, 'Last name must be at least 2 characters'),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the YYYY-MM-DD format')
    .refine((v) => new Date(v).getTime() < Date.now(), 'Must be in the past'),
  gender: z.enum(GENDERS),
  phone: z
    .string()
    .trim()
    .regex(/^[+\d][\d\s().-]{6,}$/, 'Enter a valid phone number'),
  ward: z.enum(WARDS),
  status: z.enum(PATIENT_STATUSES),
  condition: z.string().trim().min(3, 'Describe the condition'),
})
export type PatientInput = z.infer<typeof patientInputSchema>

export const appointmentInputSchema = z.object({
  patientId: z.string().min(1, 'Choose a patient'),
  doctorId: z.string().min(1, 'Choose a doctor'),
  scheduledAt: z.string().min(1, 'Choose a date and time'),
  reason: z.string().trim().min(3, 'Add a reason for the visit'),
})
export type AppointmentInput = z.infer<typeof appointmentInputSchema>

// Wire/DTO shapes: dates travel as ISO strings so server functions,
// TanStack Query and TanStack DB all share one serialisable model.
export interface Patient extends PatientInput {
  id: string
  mrn: string
  admittedAt: string
}

export interface Doctor {
  id: string
  name: string
  specialty: string
}

export interface Appointment extends AppointmentInput {
  id: string
  status: AppointmentStatus
}

export interface DashboardStats {
  totalPatients: number
  byStatus: Record<PatientStatus, number>
  byWard: Array<{ ward: string; count: number }>
  appointmentsToday: number
  appointmentsByStatus: Record<AppointmentStatus, number>
}

export const patientStatusTone = {
  ADMITTED: 'info',
  OUTPATIENT: 'neutral',
  CRITICAL: 'danger',
  DISCHARGED: 'success',
} as const

export const appointmentStatusTone = {
  SCHEDULED: 'info',
  CHECKED_IN: 'warning',
  COMPLETED: 'success',
  CANCELLED: 'neutral',
} as const

export function fullName(p: Pick<Patient, 'firstName' | 'lastName'>) {
  return `${p.firstName} ${p.lastName}`
}
