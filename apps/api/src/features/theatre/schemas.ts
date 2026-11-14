import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

export const SURGERY_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled'] as const;
export const SurgeryStatus = Type.Unsafe<(typeof SURGERY_STATUSES)[number]>({
  $id: 'SurgeryStatus',
  type: 'string',
  enum: [...SURGERY_STATUSES],
  description:
    'scheduled -> in_progress -> completed, or scheduled -> cancelled. Completed and cancelled are final.',
});

const Version = Type.Integer({ minimum: 1 });
const Id = Type.String({ maxLength: 64 });

/** The longest span the calendar can be asked for in one request. */
export const MAX_RANGE_DAYS = 62;

export const OtRoom = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    name: Type.String(),
    archived: Type.Boolean(),
    version: Version,
  },
  { $id: 'OtRoom', additionalProperties: false },
);
export type OtRoom = Static<typeof OtRoom>;
export const OtRoomPage = CursorPage(ref(OtRoom), { $id: 'OtRoomPage' });

export const OtRoomCreate = Type.Object(
  { name: Type.String({ minLength: 1, maxLength: 80, pattern: PLAIN_TEXT }) },
  { $id: 'OtRoomCreate', additionalProperties: false },
);
export const OtRoomUpdate = Type.Object(
  {
    name: Type.Optional(Type.String({ minLength: 1, maxLength: 80, pattern: PLAIN_TEXT })),
    archived: Type.Optional(Type.Boolean()),
    version: Version,
  },
  { $id: 'OtRoomUpdate', additionalProperties: false },
);
export const OtRoomParams = Type.Object({ roomId: Id });
export const OtRoomListQuery = Type.Object({
  archived: Type.Optional(
    Type.Boolean({ description: 'Include archived theatres (default: only those in use).' }),
  ),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const Surgery = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    roomId: Type.String(),
    surgeonId: Type.String({ description: 'The doctor operating (a doctor profile id).' }),
    patientId: Type.String(),
    serviceId: Type.Optional(Type.String({ description: 'The procedure service, when chosen.' })),
    encounterId: Type.Optional(
      Type.String({ description: 'The visit the surgery is charged to, when linked (#178).' }),
    ),
    procedure: Type.String(),
    notes: Type.Optional(Type.String()),
    startsAt: Type.String({ format: 'date-time' }),
    endsAt: Type.String({ format: 'date-time' }),
    status: ref(SurgeryStatus),
    startedAt: Type.Optional(Type.String({ format: 'date-time' })),
    completedAt: Type.Optional(Type.String({ format: 'date-time' })),
    cancelledAt: Type.Optional(Type.String({ format: 'date-time' })),
    version: Version,
  },
  { $id: 'Surgery', additionalProperties: false },
);
export type Surgery = Static<typeof Surgery>;
export const SurgeryPage = CursorPage(ref(Surgery), { $id: 'SurgeryPage' });

const Instant = Type.String({ format: 'date-time', maxLength: 40 });

export const SurgeryCreate = Type.Object(
  {
    patientId: Id,
    roomId: Id,
    surgeonId: Id,
    serviceId: Type.Optional(Id),
    procedure: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    notes: Type.Optional(Type.String({ minLength: 1, maxLength: 500, pattern: PLAIN_TEXT })),
    startsAt: Instant,
    endsAt: Instant,
  },
  { $id: 'SurgeryCreate', additionalProperties: false },
);
export type SurgeryCreate = Static<typeof SurgeryCreate>;

export const SurgeryReschedule = Type.Object(
  {
    roomId: Type.Optional(Id),
    surgeonId: Type.Optional(Id),
    startsAt: Instant,
    endsAt: Instant,
    version: Version,
  },
  { $id: 'SurgeryReschedule', additionalProperties: false },
);
export const SurgeryCancel = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
    version: Version,
  },
  { $id: 'SurgeryCancel', additionalProperties: false },
);
export const SurgeryProgress = Type.Object(
  { version: Version },
  { $id: 'SurgeryProgress', additionalProperties: false },
);
export const SurgeryParams = Type.Object({ surgeryId: Id });

export const SurgeryListQuery = Type.Object({
  from: Type.String({ format: 'date-time', maxLength: 40 }),
  to: Type.String({ format: 'date-time', maxLength: 40 }),
  roomId: Type.Optional(Id),
  surgeonId: Type.Optional(Id),
  status: Type.Optional(ref(SurgeryStatus)),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const SurgeryConsumableCreate = Type.Object(
  {
    drugId: Id,
    locationId: Id,
    lines: Type.Array(
      Type.Object(
        { batchId: Id, quantity: Type.Integer({ minimum: 1, maximum: 100000 }) },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 20 },
    ),
  },
  { $id: 'SurgeryConsumableCreate', additionalProperties: false },
);
export type SurgeryConsumableCreate = Static<typeof SurgeryConsumableCreate>;

export const SurgeryConsumable = Type.Object(
  {
    id: Type.String(),
    useId: Type.String({ description: 'Groups the batches taken by one recording.' }),
    drugId: Type.String(),
    batchId: Type.String(),
    locationId: Type.String(),
    quantity: Type.Integer(),
    returnedQuantity: Type.Integer({
      description: 'Units of it brought back to stock so far (#892).',
    }),
    ledgerEntryId: Type.String({ description: 'The stock ledger entry that took the units out.' }),
    itemName: Type.String({ description: 'The item as the drug and consumable master names it.' }),
    batchNumber: Type.String(),
    locationName: Type.String(),
    recordedBy: Type.String(),
    recordedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'SurgeryConsumable', additionalProperties: false },
);
export type SurgeryConsumable = Static<typeof SurgeryConsumable>;
export const SurgeryConsumableReturnCreate = Type.Object(
  {
    quantity: Type.Integer({ minimum: 1, maximum: 100000 }),
    reason: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
  },
  { $id: 'SurgeryConsumableReturnCreate', additionalProperties: false },
);
export type SurgeryConsumableReturnCreate = Static<typeof SurgeryConsumableReturnCreate>;
export const SurgeryConsumableReturnParams = Type.Object({ surgeryId: Id, consumableId: Id });
export const SurgeryConsumablePage = CursorPage(ref(SurgeryConsumable), {
  $id: 'SurgeryConsumablePage',
});
export const SurgeryConsumableListQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const THEATRE_SCHEMAS = [
  SurgeryStatus,
  OtRoom,
  OtRoomPage,
  OtRoomCreate,
  OtRoomUpdate,
  Surgery,
  SurgeryPage,
  SurgeryCreate,
  SurgeryReschedule,
  SurgeryCancel,
  SurgeryProgress,
  SurgeryConsumable,
  SurgeryConsumablePage,
  SurgeryConsumableCreate,
  SurgeryConsumableReturnCreate,
] as const;
