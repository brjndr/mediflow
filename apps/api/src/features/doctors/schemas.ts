import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

/** Monday first, as a hospital's week is written. The index plus one is the stored day. */
export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const SPECIALIZATION_MAX = 100;
export const REGISTRATION_MAX = 50;

const TIME = '^([01][0-9]|2[0-3]):[0-5][0-9]$';

const specialization = Type.String({
  minLength: 1,
  maxLength: SPECIALIZATION_MAX,
  pattern: PLAIN_TEXT,
});
const registrationNumber = Type.String({
  maxLength: REGISTRATION_MAX,
  pattern: PLAIN_TEXT,
  description: 'The medical council registration number.',
});
const consultationMinutes = Type.Integer({
  minimum: 5,
  maximum: 120,
  description: 'The usual length of one appointment.',
});

export const Doctor = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    userId: Type.String(),
    name: Type.String({ description: "The staff member's name." }),
    departmentId: Type.String(),
    departmentName: Type.String(),
    specialization: Type.String(),
    registrationNumber: Type.Optional(Type.String()),
    consultationMinutes: Type.Integer(),
    active: Type.Boolean({
      description:
        'False once the doctor no longer practises here, or while their membership of the hospital is deactivated: kept on old records, not offered for new ones.',
    }),
    version: Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' }),
  },
  {
    $id: 'Doctor',
    description:
      'A doctor profile: a staff member of one hospital, in one department. Holds no patient data.',
  },
);
export type Doctor = Static<typeof Doctor>;

export const DoctorPage = CursorPage(ref(Doctor), { $id: 'DoctorPage' });

export const DoctorCreate = Type.Object(
  {
    userId: Type.String({ maxLength: 64 }),
    departmentId: Type.String({ maxLength: 64 }),
    specialization,
    registrationNumber: Type.Optional(registrationNumber),
    consultationMinutes,
  },
  { $id: 'DoctorCreate', additionalProperties: false },
);
export type DoctorCreate = Static<typeof DoctorCreate>;

export const DoctorUpdate = Type.Object(
  {
    departmentId: Type.Optional(Type.String({ maxLength: 64 })),
    specialization: Type.Optional(specialization),
    registrationNumber: Type.Optional(registrationNumber),
    consultationMinutes: Type.Optional(consultationMinutes),
    active: Type.Optional(Type.Boolean()),
    expectedVersion: Type.Integer(),
  },
  { $id: 'DoctorUpdate', additionalProperties: false },
);
export type DoctorUpdate = Static<typeof DoctorUpdate>;

export const DoctorCandidate = Type.Object(
  { userId: Type.String(), name: Type.String(), email: Type.String() },
  {
    $id: 'DoctorCandidate',
    description:
      'A user who works at the hospital and has no doctor profile there. The email tells namesakes apart; nothing else of the account is given.',
  },
);

export const DoctorCandidatePage = CursorPage(ref(DoctorCandidate), {
  $id: 'DoctorCandidatePage',
});

export const DoctorSession = Type.Object(
  {
    day: StringEnum(WEEKDAYS),
    start: Type.String({ pattern: TIME, description: '24-hour HH:MM at the hospital.' }),
    end: Type.String({ pattern: TIME, description: '24-hour HH:MM at the hospital.' }),
  },
  { $id: 'DoctorSession', additionalProperties: false },
);
export type DoctorSession = Static<typeof DoctorSession>;

const sessions = Type.Array(ref(DoctorSession), { maxItems: 42 });

export const DoctorAvailability = Type.Object(
  { doctorId: Type.String(), sessions, version: Type.Integer() },
  {
    $id: 'DoctorAvailability',
    description: 'Regular weekly working hours. A day without a session is a day off.',
  },
);

export const DoctorAvailabilityUpdate = Type.Object(
  { sessions, expectedVersion: Type.Integer() },
  { $id: 'DoctorAvailabilityUpdate', additionalProperties: false },
);
export type DoctorAvailabilityUpdate = Static<typeof DoctorAvailabilityUpdate>;

const cursor = Type.Optional(
  Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
);
const limit = Type.Optional(
  Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
);
const q = Type.Optional(Type.String({ maxLength: 100 }));

/** Every parameter may be left out: a client asks for the first page of active doctors. */
export const DoctorListQuery = Type.Object({
  cursor,
  limit,
  q,
  departmentId: Type.Optional(Type.String({ maxLength: 64 })),
  active: Type.Optional(
    Type.Boolean({
      default: true,
      description: 'False lists the doctors who are no longer active instead.',
    }),
  ),
});

export const CandidateListQuery = Type.Object({ cursor, limit, q });

export const DOCTOR_SCHEMAS = [
  Doctor,
  DoctorPage,
  DoctorCreate,
  DoctorUpdate,
  DoctorCandidate,
  DoctorCandidatePage,
  DoctorSession,
  DoctorAvailability,
  DoctorAvailabilityUpdate,
] as const;
