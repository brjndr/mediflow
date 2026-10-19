import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';

// The enums carry an $id, unlike `StringEnum`, so the contract names them as the web app does.
export const STATUSES = ['waiting', 'called', 'served', 'skipped'] as const;
export type QueueTokenStatusValue = (typeof STATUSES)[number];

export const QueueTokenStatus = Type.Unsafe<QueueTokenStatusValue>({
  $id: 'QueueTokenStatus',
  type: 'string',
  enum: [...STATUSES],
  description:
    'waiting -> called -> served, called -> skipped (did not come), skipped -> waiting (came back). A doctor calling the next token makes the one they were serving `served`.',
});

export const PRIORITIES = [
  'senior_citizen',
  'pregnancy',
  'disability',
  'child',
  'clinical_urgency',
] as const;
export type QueuePriorityValue = (typeof PRIORITIES)[number];

export const QueuePriority = Type.Unsafe<QueuePriorityValue>({
  $id: 'QueuePriority',
  type: 'string',
  enum: [...PRIORITIES],
  description: 'Why a token goes ahead of the others.',
});

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({
  minimum: 1,
  description: 'The version the change was made from. Another one gives 409 `conflict`.',
});

export const QueueTokenCreate = Type.Object(
  {
    patientId: Id,
    departmentId: Id,
    doctorId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'A practising doctor of the department (422 `doctor_not_in_department` otherwise).',
      }),
    ),
    priority: Type.Optional(ref(QueuePriority)),
  },
  { $id: 'QueueTokenCreate', additionalProperties: false },
);
export type QueueTokenCreate = Static<typeof QueueTokenCreate>;

export const QueueToken = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    number: Type.Integer({ minimum: 1, description: 'The department’s number for the day.' }),
    day: Type.String({ format: 'date', description: 'The calendar day at the hospital.' }),
    departmentId: Type.String(),
    departmentName: Type.String(),
    doctorId: Type.Optional(
      Type.String({ description: 'Absent while any doctor of the department may call it.' }),
    ),
    doctorName: Type.Optional(Type.String()),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    status: ref(QueueTokenStatus),
    priority: Type.Optional(ref(QueuePriority)),
    issuedAt: Type.String({ format: 'date-time' }),
    calledAt: Type.Optional(
      Type.String({ format: 'date-time', description: 'The last time it was called.' }),
    ),
    callCount: Type.Integer({ minimum: 0 }),
    version: Type.Integer({ minimum: 1 }),
  },
  { $id: 'QueueToken', additionalProperties: false },
);
export type QueueToken = Static<typeof QueueToken>;

export const QueueTokenPage = CursorPage(ref(QueueToken), { $id: 'QueueTokenPage' });

export const QueueListQuery = Type.Object({
  departmentId: Type.Optional(Type.String({ maxLength: 64 })),
  doctorId: Type.Optional(Type.String({ maxLength: 64 })),
  status: ref(QueueTokenStatus),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const QueueCallNext = Type.Object(
  { doctorId: Type.String({ maxLength: 64 }) },
  { additionalProperties: false },
);
export type QueueCallNext = Static<typeof QueueCallNext>;

export const QueueTokenChange = Type.Object({ version: Version }, { additionalProperties: false });
export type QueueTokenChange = Static<typeof QueueTokenChange>;

export const QueueTokenPriorityChange = Type.Object(
  {
    version: Version,
    priority: Type.Unsafe<QueuePriorityValue | null>({
      type: ['string', 'null'],
      enum: [...PRIORITIES, null],
      description: 'Why the token goes ahead of the others, or null to clear it.',
    }),
  },
  { additionalProperties: false },
);
export type QueueTokenPriorityChange = Static<typeof QueueTokenPriorityChange>;

export const QueueTokenParams = Type.Object({ tokenId: Type.String({ maxLength: 64 }) });

export const QUEUE_SCHEMAS = [
  QueueTokenStatus,
  QueuePriority,
  QueueTokenCreate,
  QueueToken,
  QueueTokenPage,
] as const;
