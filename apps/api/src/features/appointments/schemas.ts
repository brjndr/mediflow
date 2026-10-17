import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_LINES } from '../../core/http/text.js';

// The enums carry an $id, unlike `StringEnum`, so the contract names them as the web app does.
export const STATUSES = ['scheduled', 'completed', 'cancelled', 'no_show'] as const;
export type AppointmentStatusValue = (typeof STATUSES)[number];

export const AppointmentStatus = Type.Unsafe<AppointmentStatusValue>({
  $id: 'AppointmentStatus',
  type: 'string',
  enum: [...STATUSES],
});

export const CANCEL_REASONS = [
  'patient_request',
  'doctor_unavailable',
  'hospital',
  'duplicate',
  'other',
] as const;
export const AppointmentCancelReason = Type.Unsafe<(typeof CANCEL_REASONS)[number]>({
  $id: 'AppointmentCancelReason',
  description: 'Why an appointment was cancelled.',
  type: 'string',
  enum: [...CANCEL_REASONS],
});

export const RESCHEDULE_REASONS = [
  'patient_request',
  'doctor_unavailable',
  'hospital',
  'other',
] as const;
export const AppointmentRescheduleReason = Type.Unsafe<(typeof RESCHEDULE_REASONS)[number]>({
  $id: 'AppointmentRescheduleReason',
  description: 'Why an appointment was moved.',
  type: 'string',
  enum: [...RESCHEDULE_REASONS],
});

const DAY = '^\\d{4}-\\d{2}-\\d{2}$';
const Day = (description?: string) =>
  Type.String({ format: 'date', pattern: DAY, ...(description ? { description } : {}) });
const Instant = Type.String({ format: 'date-time', description: 'UTC.' });
const Id = Type.String({ maxLength: 64 });
const Note = Type.String({
  maxLength: 500,
  pattern: PLAIN_LINES,
  description:
    'Plain text of one or more lines (no control or invisible characters). Required when the reason is `other`.',
});
const Version = Type.Integer({
  minimum: 1,
  description: 'The version the change was made from. Another one gives 409 `conflict`.',
});

const summaryFields = {
  id: Type.String(),
  tenantId: Type.String(),
  patientId: Type.String(),
  patientName: Type.String(),
  patientMrn: Type.String(),
  doctorId: Type.String(),
  doctorName: Type.String(),
  departmentName: Type.Optional(
    Type.String({ description: 'The doctor’s department. Absent when it has none.' }),
  ),
  startsAt: Instant,
  endsAt: Instant,
  status: ref(AppointmentStatus),
  version: Type.Integer({ minimum: 1 }),
};

export const AppointmentSummary = Type.Object(summaryFields, {
  $id: 'AppointmentSummary',
  additionalProperties: false,
  description:
    'An appointment as a list shows it: when, with whom, for whom and its status. Not the whole record: the reason is not in a list.',
});

export const AppointmentPage = CursorPage(ref(AppointmentSummary), { $id: 'AppointmentPage' });

export const AppointmentCancellation = Type.Object(
  {
    reason: ref(AppointmentCancelReason),
    note: Type.Optional(Type.String({ maxLength: 500 })),
  },
  {
    $id: 'AppointmentCancellation',
    additionalProperties: false,
    description: 'Why the appointment was cancelled. Present on a cancelled appointment only.',
  },
);

export const Appointment = Type.Object(
  {
    ...summaryFields,
    reason: Type.Optional(Type.String({ maxLength: 500 })),
    cancellation: Type.Optional(ref(AppointmentCancellation)),
  },
  {
    $id: 'Appointment',
    additionalProperties: false,
    description:
      'An appointment record: the list fields, the reason for the visit and, when cancelled, why.',
  },
);
export type Appointment = Static<typeof Appointment>;

export const TimeSlot = Type.Object(
  { startsAt: Instant, endsAt: Instant },
  { $id: 'TimeSlot', additionalProperties: false },
);

export const FreeSlots = Type.Object(
  {
    doctorId: Type.String(),
    day: Day(),
    slotMinutes: Type.Integer({ minimum: 5, maximum: 240 }),
    slots: Type.Array(ref(TimeSlot), { maxItems: 288 }),
  },
  {
    $id: 'FreeSlots',
    additionalProperties: false,
    description: 'A doctor’s free slots on one day at the hospital.',
  },
);

export const AppointmentCreate = Type.Object(
  {
    patientId: Id,
    doctorId: Id,
    startsAt: Type.String({
      format: 'date-time',
      description: 'UTC. The start of one of the free slots.',
    }),
    reason: Type.Optional(
      Type.String({
        maxLength: 500,
        pattern: PLAIN_LINES,
        description: 'Why the patient is coming. Plain text of one or more lines.',
      }),
    ),
    extensions: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            'Values of the fields other features add to the booking form, keyed by feature id, each part an object. Each part is checked against the schema its feature registers; a part no feature registered is refused with 422 `unknown_extension`.',
        },
      ),
    ),
  },
  { $id: 'AppointmentCreate', additionalProperties: false },
);
export type AppointmentCreate = Static<typeof AppointmentCreate>;

export const AppointmentReschedule = Type.Object(
  {
    version: Version,
    doctorId: Type.String({ maxLength: 64, description: 'The same doctor, or another one.' }),
    startsAt: Type.String({
      format: 'date-time',
      description: 'UTC. The start of one of the doctor’s free slots.',
    }),
    reason: ref(AppointmentRescheduleReason),
    note: Type.Optional(Note),
  },
  { $id: 'AppointmentReschedule', additionalProperties: false },
);
export type AppointmentReschedule = Static<typeof AppointmentReschedule>;

export const AppointmentCancel = Type.Object(
  { version: Version, reason: ref(AppointmentCancelReason), note: Type.Optional(Note) },
  { $id: 'AppointmentCancel', additionalProperties: false },
);
export type AppointmentCancel = Static<typeof AppointmentCancel>;

export const AppointmentStatusChange = Type.Object(
  { version: Version },
  { $id: 'AppointmentStatusChange', additionalProperties: false },
);
export type AppointmentStatusChange = Static<typeof AppointmentStatusChange>;

export const AppointmentListQuery = Type.Object({
  from: Day('The first day, at the hospital.'),
  to: Day('The last day, at the hospital, included. At most 30 days after `from`.'),
  doctorId: Type.Optional(
    Type.String({ maxLength: 64, description: 'Only this doctor’s appointments.' }),
  ),
  status: Type.Optional(ref(AppointmentStatus)),
  cursor: Type.Optional(
    Type.String({
      maxLength: 200,
      description: 'Opaque. Pass the nextCursor of the previous page.',
    }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const FreeSlotsQuery = Type.Object({
  doctorId: Type.String({ maxLength: 64 }),
  day: Day('A day at the hospital.'),
});

export const AppointmentParams = Type.Object({ appointmentId: Type.String({ maxLength: 64 }) });

export const APPOINTMENT_SCHEMAS = [
  AppointmentStatus,
  AppointmentCancelReason,
  AppointmentRescheduleReason,
  AppointmentSummary,
  AppointmentPage,
  AppointmentCancellation,
  Appointment,
  TimeSlot,
  FreeSlots,
  AppointmentCreate,
  AppointmentReschedule,
  AppointmentCancel,
  AppointmentStatusChange,
] as const;
