// Deterministic seed data shared by the in-memory repository and
// `prisma/seed.ts`. Relative imports only: tsx runs this outside Vite.
import { faker } from '@faker-js/faker'

import { GENDERS, PATIENT_STATUSES, WARDS } from './schemas'
import type {
  Appointment,
  AppointmentStatus,
  Doctor,
  Patient,
  PatientStatus,
} from './schemas'
import type { Stage } from './workflow'

const CONDITIONS = [
  'Hypertension',
  'Type 2 diabetes',
  'Fractured wrist',
  'Pneumonia',
  'Migraine',
  'Appendicitis',
  'Asthma',
  'Arrhythmia',
  'Post-operative recovery',
  'Routine check-up',
]

const SPECIALTIES = [
  'Cardiology',
  'Neurology',
  'Pediatrics',
  'Oncology',
  'Orthopedics',
  'Emergency Medicine',
  'Obstetrics',
  'Internal Medicine',
]

function stageFor(status: PatientStatus): Stage {
  switch (status) {
    case 'ADMITTED':
      return faker.helpers.arrayElement(['ADMITTED', 'TREATMENT'] as const)
    case 'CRITICAL':
      return 'TREATMENT'
    case 'DISCHARGED':
      return 'DISCHARGED'
    case 'OUTPATIENT':
      return faker.helpers.arrayElement(['REGISTERED', 'TRIAGE'] as const)
  }
}

export function buildSeed(now = new Date()) {
  faker.seed(20260508)

  const doctors: Array<Doctor> = SPECIALTIES.map((specialty, i) => ({
    id: `d_${String(i + 1).padStart(2, '0')}`,
    name: `Dr. ${faker.person.firstName()} ${faker.person.lastName()}`,
    specialty,
  }))

  const patients: Array<Patient> = Array.from({ length: 64 }, (_, i) => {
    const status = faker.helpers.weightedArrayElement([
      { weight: 5, value: PATIENT_STATUSES[0] },
      { weight: 5, value: PATIENT_STATUSES[1] },
      { weight: 1, value: PATIENT_STATUSES[2] },
      { weight: 3, value: PATIENT_STATUSES[3] },
    ])
    return {
      id: `p_${String(i + 1).padStart(3, '0')}`,
      mrn: `MRN-${String(100200 + i)}`,
      firstName: faker.person.firstName(),
      lastName: faker.person.lastName(),
      dateOfBirth: faker.date
        .birthdate({ min: 1, max: 92, mode: 'age', refDate: now })
        .toISOString()
        .slice(0, 10),
      gender: faker.helpers.arrayElement(GENDERS),
      phone: faker.phone.number({ style: 'international' }),
      ward: status === 'CRITICAL' ? 'ICU' : faker.helpers.arrayElement(WARDS),
      status,
      condition: faker.helpers.arrayElement(CONDITIONS),
      admittedAt: faker.date.recent({ days: 30, refDate: now }).toISOString(),
      stage: stageFor(status),
    }
  })

  const appointments: Array<Appointment> = Array.from(
    { length: 48 },
    (_, i) => {
      const dayOffset = faker.number.int({ min: -2, max: 5 })
      const at = new Date(now)
      at.setDate(at.getDate() + dayOffset)
      at.setHours(
        faker.number.int({ min: 8, max: 17 }),
        faker.helpers.arrayElement([0, 15, 30, 45]),
        0,
        0,
      )
      const status: AppointmentStatus =
        dayOffset < 0
          ? faker.helpers.arrayElement([
              'COMPLETED',
              'COMPLETED',
              'CANCELLED',
            ] as const)
          : 'SCHEDULED'
      return {
        id: `a_${String(i + 1).padStart(3, '0')}`,
        patientId: faker.helpers.arrayElement(patients).id,
        doctorId: faker.helpers.arrayElement(doctors).id,
        scheduledAt: at.toISOString(),
        reason: faker.helpers.arrayElement([
          'Follow-up consultation',
          'Lab review',
          'Pre-operative assessment',
          'Imaging results',
          'Medication review',
        ]),
        status,
      }
    },
  )

  return { doctors, patients, appointments }
}
