import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

export const LOCATION_NAME_MAX = 100;
export const BATCH_NUMBER_MAX = 40;
export const NOTE_MAX = 200;
/** The most one adjustment moves, either way. */
export const QUANTITY_MAX = 1_000_000;
/** The most a price may be, in minor units. */
export const MONEY_MAX = 100_000_000_000;
/** How far ahead a batch counts as expiring when the request does not say: days. */
export const EXPIRING_DAYS_DEFAULT = 90;
export const EXPIRING_DAYS_MAX = 365;

// The enums carry an $id, unlike `StringEnum`, so the contract names them as the web app does.
const named = <const Values extends readonly string[]>(
  $id: string,
  values: Values,
  description: string,
) => Type.Unsafe<Values[number]>({ $id, type: 'string', enum: [...values], description });

export const LOCATION_KINDS = ['store', 'pharmacy', 'ward'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];
export const StockLocationKind = named(
  'StockLocationKind',
  LOCATION_KINDS,
  'What a place that keeps stock is: a store, a pharmacy counter, or a ward’s own stock.',
);

export const ADJUSTMENT_REASONS = [
  'opening',
  'count_correction',
  'damaged',
  'expired',
  'other',
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];
export const StockAdjustmentReason = named(
  'StockAdjustmentReason',
  ADJUSTMENT_REASONS,
  'Why stock is adjusted: opening stock (brought in, the only reason that may describe a new batch), a correction after a count (either way), damaged or expired stock (taken out), or another reason given in the note.',
);

export const ADJUSTMENT_STATUSES = ['pending', 'approved', 'rejected'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];
export const StockAdjustmentStatus = named(
  'StockAdjustmentStatus',
  ADJUSTMENT_STATUSES,
  'An adjustment waits for a second person, who approves it (stock moves, in the ledger) or rejects it (nothing moves).',
);

export const STOCK_ALERTS = ['low', 'expiring', 'expired'] as const;
export type StockAlert = (typeof STOCK_ALERTS)[number];

export const EXPIRY_STATES = ['ok', 'expiring', 'expired'] as const;
export const StockExpiryState = named(
  'StockExpiryState',
  EXPIRY_STATES,
  'Whether a batch is past its expiry date at the hospital today (`expired`), expires within the days asked (`expiring`), or neither.',
);

export const LEDGER_SOURCES = ['adjustment'] as const;
export const StockLedgerSource = named(
  'StockLedgerSource',
  LEDGER_SOURCES,
  'What made a ledger entry. Goods receipts, dispenses and transfers come with their modules.',
);

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({
  description:
    'Counts the changes. Sent back as expectedVersion; another one gives 409 `conflict`.',
});
const ExpectedVersion = Type.Integer({ description: 'The version the change was made from.' });
const LocationName = Type.String({
  minLength: 1,
  maxLength: LOCATION_NAME_MAX,
  pattern: PLAIN_TEXT,
});
const Note = Type.String({ minLength: 1, maxLength: NOTE_MAX, pattern: PLAIN_TEXT });
const Money = Type.Integer({ minimum: 0, maximum: MONEY_MAX });
const CalendarDate = Type.String({
  format: 'date',
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'A calendar date, not an instant: YYYY-MM-DD.',
});

export const StockLocation = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    name: Type.String(),
    kind: ref(StockLocationKind),
    archived: Type.Boolean(),
    version: Version,
  },
  { $id: 'StockLocation', description: 'A place of the hospital that keeps stock.' },
);
export type StockLocation = Static<typeof StockLocation>;

export const StockLocationPage = CursorPage(ref(StockLocation), { $id: 'StockLocationPage' });

export const StockLocationListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  archived: Type.Optional(
    Type.Boolean({ description: 'The archived places instead of those in use.' }),
  ),
});

export const StockLocationCreate = Type.Object(
  { name: LocationName, kind: ref(StockLocationKind) },
  { $id: 'StockLocationCreate', additionalProperties: false },
);
export type StockLocationCreate = Static<typeof StockLocationCreate>;

export const StockLocationUpdate = Type.Object(
  {
    expectedVersion: ExpectedVersion,
    name: Type.Optional(LocationName),
    kind: Type.Optional(ref(StockLocationKind)),
  },
  { $id: 'StockLocationUpdate', additionalProperties: false },
);
export type StockLocationUpdate = Static<typeof StockLocationUpdate>;

export const StockItemName = Type.Object(
  {
    drugId: Type.String(),
    type: StringEnum(['medicine', 'consumable'] as const),
    genericName: Type.String(),
    brandName: Type.Optional(Type.String()),
    form: Type.String(),
    strength: Type.Optional(Type.String()),
    unit: Type.Optional(Type.String({ description: 'What one unit of stock is.' })),
  },
  {
    $id: 'StockItemName',
    description: 'An item of the drug and consumable master, as it reads now.',
  },
);
export type StockItemName = Static<typeof StockItemName>;

export const StockBatchBalance = Type.Object(
  {
    batchId: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    mrpMinor: Type.Optional(Type.Integer()),
    locationId: Type.String(),
    locationName: Type.String(),
    onHand: Type.Integer({ minimum: 1 }),
    expiry: ref(StockExpiryState),
  },
  {
    $id: 'StockBatchBalance',
    description: 'How many units of a batch are at one place. Only batches with stock are listed.',
  },
);
export type StockBatchBalance = Static<typeof StockBatchBalance>;

export const StockItem = Type.Object(
  {
    item: ref(StockItemName),
    reorderLevel: Type.Optional(
      Type.Integer({ description: 'Stock of the whole hospital at or below this is low.' }),
    ),
    onHand: Type.Integer({
      description: 'Units on hand at the place asked, or at the whole hospital when none was.',
    }),
    hospitalOnHand: Type.Integer({ description: 'Units on hand at the whole hospital.' }),
    low: Type.Boolean({
      description: 'The hospital’s stock is at or below the reorder level. Never without a level.',
    }),
    batches: Type.Array(ref(StockBatchBalance), {
      description: 'The batches with stock at the place asked (or anywhere), soonest expiry first.',
    }),
  },
  { $id: 'StockItem', description: 'An item and its stock.' },
);
export type StockItem = Static<typeof StockItem>;

export const StockItemPage = CursorPage(ref(StockItem), { $id: 'StockItemPage' });

const ExpiringDays = Type.Integer({
  minimum: 1,
  maximum: EXPIRING_DAYS_MAX,
  description: `A batch expiring within this many days of today at the hospital is expiring: ${EXPIRING_DAYS_DEFAULT} when not sent.`,
});

export const StockListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  locationId: Type.Optional(Id),
  drugId: Type.Optional(Type.String({ maxLength: 64, description: 'One item only.' })),
  alert: Type.Optional(
    StringEnum(STOCK_ALERTS, {
      description:
        'Only items whose hospital stock is low (whatever the place), or that have a batch with stock at the place that is expiring or expired.',
    }),
  ),
  expiringWithinDays: Type.Optional(ExpiringDays),
});
export type StockListQuery = Static<typeof StockListQuery>;

export const StockAlertCounts = Type.Object(
  {
    low: Type.Integer({ minimum: 0, description: 'Items whose hospital stock is low.' }),
    expiring: Type.Integer({ minimum: 0, description: 'Items with stock expiring at the place.' }),
    expired: Type.Integer({ minimum: 0, description: 'Items with expired stock at the place.' }),
  },
  { $id: 'StockAlertCounts' },
);
export type StockAlertCounts = Static<typeof StockAlertCounts>;

export const StockAlertQuery = Type.Object({
  locationId: Type.Optional(Id),
  expiringWithinDays: Type.Optional(ExpiringDays),
});

export const StockLedgerEntry = Type.Object(
  {
    id: Type.String(),
    at: Type.String({ format: 'date-time' }),
    item: ref(StockItemName),
    batchId: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    locationId: Type.String(),
    locationName: Type.String(),
    quantity: Type.Integer({ description: 'Positive in, negative out.' }),
    balanceAfter: Type.Integer({
      description: 'The batch’s stock at the place right after the entry.',
    }),
    source: ref(StockLedgerSource),
    sourceId: Type.String(),
    reason: ref(StockAdjustmentReason),
    actorName: Type.String({
      description: 'Who made the change: for an adjustment, the approver.',
    }),
  },
  {
    $id: 'StockLedgerEntry',
    description: 'One change of stock. The ledger is append-only: a correction is a new entry.',
  },
);
export type StockLedgerEntry = Static<typeof StockLedgerEntry>;

export const StockLedgerPage = CursorPage(ref(StockLedgerEntry), { $id: 'StockLedgerPage' });

export const StockLedgerQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  drugId: Type.Optional(Id),
  batchId: Type.Optional(Id),
  locationId: Type.Optional(Id),
  from: Type.Optional(Type.String({ format: 'date-time', description: 'At or after.' })),
  to: Type.Optional(Type.String({ format: 'date-time', description: 'Before.' })),
});
export type StockLedgerQuery = Static<typeof StockLedgerQuery>;

export const StockAdjustment = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    locationId: Type.String(),
    locationName: Type.String(),
    item: ref(StockItemName),
    batchId: Type.Optional(Type.String({ description: 'Empty for a new batch not yet approved.' })),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    newBatch: Type.Boolean({
      description: 'The adjustment brings in a batch new to the hospital.',
    }),
    mrpMinor: Type.Optional(Type.Integer()),
    costMinor: Type.Optional(Type.Integer()),
    quantity: Type.Integer({ description: 'Positive in, negative out.' }),
    reason: ref(StockAdjustmentReason),
    note: Type.Optional(Type.String()),
    onHand: Type.Integer({ description: 'The batch’s stock at the place now.' }),
    status: ref(StockAdjustmentStatus),
    requestedById: Type.String(),
    requestedByName: Type.String(),
    requestedAt: Type.String({ format: 'date-time' }),
    decidedByName: Type.Optional(Type.String()),
    decidedAt: Type.Optional(Type.String({ format: 'date-time' })),
    rejectionNote: Type.Optional(Type.String()),
    version: Version,
  },
  {
    $id: 'StockAdjustment',
    description:
      'A change of stock asked for by one person and decided by another. Only an approved one moves stock, through the ledger.',
  },
);
export type StockAdjustment = Static<typeof StockAdjustment>;

export const StockAdjustmentPage = CursorPage(ref(StockAdjustment), {
  $id: 'StockAdjustmentPage',
});

export const StockAdjustmentListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  status: Type.Optional(ref(StockAdjustmentStatus)),
});

export const StockAdjustmentCreate = Type.Object(
  {
    locationId: Id,
    drugId: Id,
    batchId: Type.Optional(
      Type.String({ maxLength: 64, description: 'A batch of the item. Or describe a new one.' }),
    ),
    batchNumber: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: BATCH_NUMBER_MAX,
        pattern: PLAIN_TEXT,
        description: 'A new batch, as printed on the pack: opening stock only.',
      }),
    ),
    expiryDate: Type.Optional(CalendarDate),
    mrpMinor: Type.Optional(Money),
    costMinor: Type.Optional(Money),
    quantity: Type.Integer({ minimum: -QUANTITY_MAX, maximum: QUANTITY_MAX }),
    reason: ref(StockAdjustmentReason),
    note: Type.Optional(Note),
  },
  { $id: 'StockAdjustmentCreate', additionalProperties: false },
);
export type StockAdjustmentCreate = Static<typeof StockAdjustmentCreate>;

export const StockAdjustmentApprove = Type.Object(
  { expectedVersion: ExpectedVersion },
  { $id: 'StockAdjustmentApprove', additionalProperties: false },
);
export type StockAdjustmentApprove = Static<typeof StockAdjustmentApprove>;

export const StockAdjustmentReject = Type.Object(
  { expectedVersion: ExpectedVersion, note: Note },
  { $id: 'StockAdjustmentReject', additionalProperties: false },
);
export type StockAdjustmentReject = Static<typeof StockAdjustmentReject>;

export const INVENTORY_SCHEMAS = [
  StockLocationKind,
  StockAdjustmentReason,
  StockAdjustmentStatus,
  StockExpiryState,
  StockLedgerSource,
  StockLocation,
  StockLocationPage,
  StockLocationCreate,
  StockLocationUpdate,
  StockItemName,
  StockBatchBalance,
  StockItem,
  StockItemPage,
  StockAlertCounts,
  StockLedgerEntry,
  StockLedgerPage,
  StockAdjustment,
  StockAdjustmentPage,
  StockAdjustmentCreate,
  StockAdjustmentApprove,
  StockAdjustmentReject,
] as const;
