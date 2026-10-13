import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

export const CODE_MAX = 20;
export const NAME_MAX = 100;
export const FLOOR_MAX = 50;
export const ROOM_NAME_MAX = 50;
export const BED_NUMBER_MAX = 20;
export const NOTE_MAX = 100;
/**
 * The most rooms and beds a ward can have, archived ones counted: every change of a ward answers
 * with the whole ward, and nothing of it is ever deleted. Far above any real ward.
 */
export const ROOMS_PER_WARD_MAX = 200;
export const BEDS_PER_WARD_MAX = 1000;

export const BED_STATUSES = ['available', 'occupied', 'cleaning', 'blocked'] as const;
export type BedStatus = (typeof BED_STATUSES)[number];

export const BLOCK_REASONS = [
  'repair',
  'maintenance',
  'deep_cleaning',
  'reserved',
  'other',
] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

const Version = Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' });
const Name = Type.String({ minLength: 1, maxLength: NAME_MAX, pattern: PLAIN_TEXT });
const ServiceId = Type.String({
  maxLength: 64,
  description:
    "The bed-day service a day in a bed of this category is charged as: a service of the same hospital's catalog in its bed category. Empty text removes the link on a change.",
});
const Floor = Type.String({
  maxLength: FLOOR_MAX,
  pattern: PLAIN_TEXT,
  description: 'Where it is: a floor, a block, a wing.',
});
const DepartmentId = Type.String({
  maxLength: 64,
  description:
    'The department the ward belongs to, when it belongs to one. Empty text removes it on a change.',
});
const RoomName = Type.String({ minLength: 1, maxLength: ROOM_NAME_MAX, pattern: PLAIN_TEXT });
const BedNumber = Type.String({
  minLength: 1,
  maxLength: BED_NUMBER_MAX,
  pattern: PLAIN_TEXT,
  description: 'What is written on the bed: unique in its ward.',
});

export const BedCategory = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    name: Type.String({ minLength: 1, maxLength: NAME_MAX }),
    serviceId: Type.Optional(Type.String()),
    serviceName: Type.Optional(
      Type.String({
        description:
          'The name of the linked service, when there is one. The name alone is shown to everyone who may read wards, by decision; nothing else of the service (a price, a tax class) is ever added here.',
      }),
    ),
    bedCount: Type.Integer({ description: 'The beds in use that have this category.' }),
    archived: Type.Boolean(),
    version: Version,
  },
  {
    $id: 'BedCategory',
    description:
      'A class of bed (general ward, private room, intensive care), which decides what a day in it is charged as. The charge itself is posted by the admissions module from the linked service, at the price in force that day. An admission keeps the category and the service of its bed as they were when the patient was given it, so a change made here applies to stays that start after it.',
  },
);
export type BedCategory = Static<typeof BedCategory>;

export const BedCategoryPage = CursorPage(ref(BedCategory), { $id: 'BedCategoryPage' });

export const BedCategoryCreate = Type.Object(
  { name: Name, serviceId: Type.Optional(ServiceId) },
  { $id: 'BedCategoryCreate', additionalProperties: false },
);
export type BedCategoryCreate = Static<typeof BedCategoryCreate>;

export const BedCategoryUpdate = Type.Object(
  {
    name: Type.Optional(Name),
    serviceId: Type.Optional(ServiceId),
    expectedVersion: Type.Integer(),
  },
  { $id: 'BedCategoryUpdate', additionalProperties: false },
);
export type BedCategoryUpdate = Static<typeof BedCategoryUpdate>;

export const Ward = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    code: Type.String({ description: 'Short and unique in the hospital. Never changes.' }),
    name: Type.String({ minLength: 1, maxLength: NAME_MAX }),
    floor: Type.Optional(Type.String({ maxLength: FLOOR_MAX })),
    departmentId: Type.Optional(Type.String()),
    departmentName: Type.Optional(Type.String()),
    roomCount: Type.Integer({ description: 'Rooms in use.' }),
    bedCount: Type.Integer({ description: 'Beds in use.' }),
    archived: Type.Boolean(),
    version: Version,
  },
  { $id: 'Ward', description: 'A ward of the hospital. Holds no patient data.' },
);
export type Ward = Static<typeof Ward>;

export const WardPage = CursorPage(ref(Ward), { $id: 'WardPage' });

export const WardCreate = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: CODE_MAX,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    }),
    name: Name,
    floor: Type.Optional(Floor),
    departmentId: Type.Optional(DepartmentId),
  },
  { $id: 'WardCreate', additionalProperties: false },
);
export type WardCreate = Static<typeof WardCreate>;

export const WardUpdate = Type.Object(
  {
    name: Type.Optional(Name),
    floor: Type.Optional(Floor),
    departmentId: Type.Optional(DepartmentId),
    expectedVersion: Type.Integer(),
  },
  { $id: 'WardUpdate', additionalProperties: false },
);
export type WardUpdate = Static<typeof WardUpdate>;

export const Bed = Type.Object(
  {
    id: Type.String(),
    roomId: Type.String(),
    number: Type.String({ minLength: 1, maxLength: BED_NUMBER_MAX }),
    bedCategoryId: Type.String(),
    bedCategoryName: Type.String(),
    status: StringEnum(BED_STATUSES, {
      description:
        'available: free to take a patient. occupied: a patient is admitted to it (set by admissions). cleaning: being made ready after a discharge (set by housekeeping). blocked: taken out of use here, with a reason.',
    }),
    blockedReason: Type.Optional(StringEnum(BLOCK_REASONS, { description: 'Why it is blocked.' })),
    blockedNote: Type.Optional(
      Type.String({
        description: 'A few words more about why. About the bed, never about a patient.',
      }),
    ),
    archived: Type.Boolean(),
    version: Version,
  },
  {
    $id: 'Bed',
    description:
      'A bed. Its status says whether it can take a patient; who is in it is the admission module, never here.',
  },
);
export type Bed = Static<typeof Bed>;

export const Room = Type.Object(
  {
    id: Type.String(),
    name: Type.String(),
    beds: Type.Array(ref(Bed)),
    archived: Type.Boolean(),
    version: Version,
  },
  { $id: 'Room' },
);
export type Room = Static<typeof Room>;

export const WardDetail = Type.Object(
  { ward: ref(Ward), rooms: Type.Array(ref(Room)) },
  {
    $id: 'WardDetail',
    description: 'A ward with its rooms and their beds, archived ones included.',
  },
);
export type WardDetail = Static<typeof WardDetail>;

export const RoomCreate = Type.Object(
  { name: RoomName },
  { $id: 'RoomCreate', additionalProperties: false },
);
export type RoomCreate = Static<typeof RoomCreate>;

export const RoomUpdate = Type.Object(
  { name: RoomName, expectedVersion: Type.Integer() },
  { $id: 'RoomUpdate', additionalProperties: false },
);
export type RoomUpdate = Static<typeof RoomUpdate>;

export const BedCreate = Type.Object(
  { number: BedNumber, bedCategoryId: Type.String({ maxLength: 64 }) },
  { $id: 'BedCreate', additionalProperties: false },
);
export type BedCreate = Static<typeof BedCreate>;

export const BedUpdate = Type.Object(
  {
    number: Type.Optional(BedNumber),
    bedCategoryId: Type.Optional(Type.String({ maxLength: 64 })),
    expectedVersion: Type.Integer(),
  },
  { $id: 'BedUpdate', additionalProperties: false },
);
export type BedUpdate = Static<typeof BedUpdate>;

export const BedBlock = Type.Object(
  {
    reason: StringEnum(BLOCK_REASONS),
    note: Type.Optional(
      Type.String({
        maxLength: NOTE_MAX,
        pattern: PLAIN_TEXT,
        description:
          'A few words more: about the bed, never about a patient. Free text, so the API treats it as possibly sensitive: it is not written to logs or to event payloads.',
      }),
    ),
  },
  { $id: 'BedBlock', additionalProperties: false },
);
export type BedBlock = Static<typeof BedBlock>;

const cursor = Type.Optional(
  Type.String({
    maxLength: 1024,
    description: 'Opaque. Pass the nextCursor of the previous page.',
  }),
);
const limit = Type.Optional(
  Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
);
const archived = (what: string) =>
  Type.Optional(
    Type.Boolean({
      default: false,
      description: `True lists the archived ${what} instead of the active ones.`,
    }),
  );

/** A list, not a search made while recording care: a ward's name says nothing of a patient. */
export const WardListQuery = Type.Object({
  cursor,
  limit,
  q: Type.Optional(Type.String({ maxLength: 100, pattern: PLAIN_TEXT })),
  archived: archived('wards'),
});

export const BedCategoryListQuery = Type.Object({
  cursor,
  limit,
  archived: archived('bed categories'),
});

export const WARD_SCHEMAS = [
  BedCategory,
  BedCategoryPage,
  BedCategoryCreate,
  BedCategoryUpdate,
  Ward,
  WardPage,
  WardCreate,
  WardUpdate,
  Bed,
  Room,
  WardDetail,
  RoomCreate,
  RoomUpdate,
  BedCreate,
  BedUpdate,
  BedBlock,
] as const;
