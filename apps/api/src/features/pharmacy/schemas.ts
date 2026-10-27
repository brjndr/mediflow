import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

export const REASON_MAX = 200;
/** The most units of one line, as a prescription line's quantity. */
export const QUANTITY_MAX = 10_000;
/** The most batches one dispense takes from. */
export const BATCHES_MAX = 10;
/** How far back the queue looks when the request does not say: days. */
export const QUEUE_DAYS_DEFAULT = 7;
export const QUEUE_DAYS_MAX = 90;

export const QUEUE_STATES = ['open', 'done'] as const;
export type QueueState = (typeof QUEUE_STATES)[number];

const Id = Type.String({ maxLength: 64 });
const CalendarDate = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'A calendar date, `YYYY-MM-DD`.',
});
const OrderStatus = StringEnum(['placed', 'accepted', 'in_progress', 'completed', 'cancelled'], {
  description:
    'The order’s status: placed or accepted until something is dispensed, in progress once some is, completed when all is (or the pharmacist completes it), cancelled by the doctor.',
});

export const PharmacyQueueQuery = Type.Object({
  state: Type.Optional(
    StringEnum(QUEUE_STATES, {
      description:
        '`open` (the default): with a line still to dispense, the oldest first. `done`: every line completed or cancelled and at least one dispensed, the newest first.',
    }),
  ),
  days: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: QUEUE_DAYS_MAX,
      description: `Prescribed within this many days at the hospital, today included. Default ${QUEUE_DAYS_DEFAULT}.`,
    }),
  ),
  patientId: Type.Optional(Type.String({ description: 'One patient’s prescriptions only.' })),
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
});
export type PharmacyQueueQuery = Static<typeof PharmacyQueueQuery>;

export const PharmacyQueueItem = Type.Object(
  {
    prescriptionId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    prescribedAt: Type.String({ format: 'date-time' }),
    prescribedByName: Type.String(),
    lineCount: Type.Integer({ description: 'Its medication lines, cancelled ones included.' }),
    openLineCount: Type.Integer({
      description: 'Lines still to dispense: placed, accepted or in progress.',
    }),
    startedLineCount: Type.Integer({
      description: 'Lines with some dispensed: in progress or completed.',
    }),
  },
  {
    $id: 'PharmacyQueueItem',
    description: 'A prescription in the pharmacy’s queue, with who it is for.',
  },
);
export type PharmacyQueueItem = Static<typeof PharmacyQueueItem>;

export const PharmacyQueuePage = CursorPage(ref(PharmacyQueueItem), { $id: 'PharmacyQueuePage' });

export const DispenseBatch = Type.Object(
  {
    batchId: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    quantity: Type.Integer(),
  },
  { $id: 'DispenseBatch', description: 'Units of one batch given in a dispense.' },
);

export const Dispense = Type.Object(
  {
    id: Type.String(),
    orderId: Type.String(),
    prescriptionId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    locationId: Type.String(),
    locationName: Type.String(),
    prescribedDrugId: Type.String(),
    drugId: Type.String({ description: 'The item given: the prescribed one, or its substitute.' }),
    itemName: Type.String({ description: 'The item given as it read when dispensed.' }),
    schedule: Type.String(),
    controlled: Type.Boolean(),
    substitutionReason: Type.Optional(
      Type.String({ description: 'Why another brand was given; only for a substitute.' }),
    ),
    quantity: Type.Integer(),
    batches: Type.Array(ref(DispenseBatch)),
    dispensedAt: Type.String({ format: 'date-time' }),
    dispensedByName: Type.String(),
  },
  {
    $id: 'Dispense',
    description: 'Units given against a prescription line. Never changed or removed.',
  },
);
export type Dispense = Static<typeof Dispense>;

export const PharmacyLine = Type.Object(
  {
    orderId: Type.String(),
    lineNumber: Type.Integer(),
    version: Type.Integer({ description: 'Sent back as expectedVersion.' }),
    status: OrderStatus,
    drugId: Type.String(),
    itemName: Type.String({ description: 'The medicine as it read when prescribed.' }),
    dose: Type.String(),
    frequency: Type.String(),
    route: Type.String(),
    durationDays: Type.Optional(Type.Integer()),
    quantity: Type.Optional(
      Type.Integer({ description: 'How much to dispense; absent when the doctor did not say.' }),
    ),
    instructions: Type.Optional(Type.String()),
    cancelReason: Type.Optional(Type.String()),
    dispensedQuantity: Type.Integer({ description: 'Units given so far, every dispense.' }),
  },
  { $id: 'PharmacyLine', description: 'A medication line of a prescription, as dispensed.' },
);
export type PharmacyLine = Static<typeof PharmacyLine>;

export const PharmacyPrescription = Type.Object(
  {
    prescriptionId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    prescribedAt: Type.String({ format: 'date-time' }),
    prescribedByName: Type.String(),
    advice: Type.Optional(Type.String()),
    replacesId: Type.Optional(Type.String()),
    replacedById: Type.Optional(Type.String()),
    lines: Type.Array(ref(PharmacyLine)),
    dispenses: Type.Array(ref(Dispense), { description: 'Oldest first.' }),
  },
  {
    $id: 'PharmacyPrescription',
    description: 'A prescription as the pharmacy dispenses it: its lines and its dispenses.',
  },
);
export type PharmacyPrescription = Static<typeof PharmacyPrescription>;

export const UsableBatchView = Type.Object(
  {
    batchId: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    onHand: Type.Integer({ description: 'Units at the place.' }),
    mrpMinor: Type.Optional(
      Type.String({ description: 'Maximum retail price of a unit, in minor units.' }),
    ),
  },
  {
    $id: 'DispensableBatch',
    description: 'A batch in date with stock at the place.',
  },
);

export const DispensableItem = Type.Object(
  {
    drugId: Type.String(),
    name: Type.String(),
    schedule: Type.String(),
    controlled: Type.Boolean(),
    batches: Type.Array(ref(UsableBatchView), { description: 'Nearest expiry first.' }),
  },
  { $id: 'DispensableItem', description: 'An item that may be given, with its batches.' },
);

export const DispenseOptions = Type.Object(
  {
    prescribed: Type.Optional(ref(DispensableItem)),
    substitutes: Type.Array(ref(DispensableItem), {
      description: 'Other brands of the same generic name, form and strength, in use.',
    }),
  },
  {
    $id: 'DispenseOptions',
    description:
      'What may be given for a line at a place: the prescribed item (absent once archived) and its generic substitutes, each with its batches in date there, nearest expiry first.',
  },
);
export type DispenseOptions = Static<typeof DispenseOptions>;

export const DispenseOptionsQuery = Type.Object({
  locationId: Type.String({ description: 'The place to give from.' }),
});

export const DispenseCreate = Type.Object(
  {
    orderId: Id,
    expectedVersion: Type.Integer({
      description: 'The order’s version the dispense was made from.',
    }),
    expectedDispensedQuantity: Type.Integer({
      minimum: 0,
      description:
        'The units dispensed against the line when the dispense was made (its dispensedQuantity): another dispense meanwhile is 409 conflict.',
    }),
    locationId: Id,
    drugId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'A generic substitute to give instead; absent gives the prescribed item. Needs substitutionReason.',
      }),
    ),
    substitutionReason: Type.Optional(
      Type.String({ minLength: 1, maxLength: REASON_MAX, pattern: PLAIN_TEXT }),
    ),
    batches: Type.Array(
      Type.Object(
        {
          batchId: Id,
          quantity: Type.Integer({ minimum: 1, maximum: QUANTITY_MAX }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: BATCHES_MAX, description: 'Each batch once.' },
    ),
  },
  { $id: 'DispenseCreate', additionalProperties: false },
);
export type DispenseCreate = Static<typeof DispenseCreate>;

export const LineComplete = Type.Object(
  { expectedVersion: Type.Integer({ description: 'The order’s version.' }) },
  { $id: 'PharmacyLineComplete', additionalProperties: false },
);
export type LineComplete = Static<typeof LineComplete>;

export const PHARMACY_SCHEMAS = [
  PharmacyQueueItem,
  PharmacyQueuePage,
  DispenseBatch,
  Dispense,
  PharmacyLine,
  PharmacyPrescription,
  UsableBatchView,
  DispensableItem,
  DispenseOptions,
  DispenseCreate,
  LineComplete,
] as const;
