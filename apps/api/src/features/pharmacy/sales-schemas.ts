import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { BATCHES_MAX, QUANTITY_MAX, REASON_MAX, UsableBatchView } from './schemas.js';

/** The most items in one sale. */
export const SALE_ITEMS_MAX = 20;
export const PRESCRIBER_NAME_MAX = 120;
export const PRESCRIBER_REGISTRATION_MAX = 40;
/** How far back the sales list looks when the request does not say: days. */
export const SALES_DAYS_DEFAULT = 7;
export const SALES_DAYS_MAX = 90;
/** The longest stretch of the register read at once: days. */
export const REGISTER_DAYS_MAX = 366;

/** Schedules sold only against a prescription, recorded on the sale (controlled items too). */
export const PRESCRIPTION_SCHEDULES = ['h', 'h1', 'x', 'narcotic'] as const;
/** Schedules whose every movement is in the drug register (controlled items too). */
export const REGISTER_SCHEDULES = ['h1', 'x', 'narcotic'] as const;

export const needsPrescription = (item: { schedule: string; controlled: boolean }): boolean =>
  item.controlled || (PRESCRIPTION_SCHEDULES as readonly string[]).includes(item.schedule);
export const inRegister = (item: { schedule: string; controlled: boolean }): boolean =>
  item.controlled || (REGISTER_SCHEDULES as readonly string[]).includes(item.schedule);

const Id = Type.String({ maxLength: 64 });
const CalendarDate = Type.String({
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: 'A calendar date, `YYYY-MM-DD`.',
});
const Minor = (description: string) =>
  Type.String({ pattern: '^\\d+$', description: `${description}, in minor units, as text.` });

export const SaleItemOptionsQuery = Type.Object({
  drugId: Type.String({ description: 'The item to sell.' }),
  locationId: Type.String({ description: 'The place to sell from.' }),
});

export const SaleItemOptions = Type.Object(
  {
    drugId: Type.String(),
    name: Type.String(),
    schedule: Type.String(),
    controlled: Type.Boolean(),
    needsPrescription: Type.Boolean({
      description:
        'Schedule H, H1, X, narcotic or controlled: sold only to a registered patient against an outside prescription recorded on the sale.',
    }),
    inRegister: Type.Boolean({
      description:
        'Schedule H1, X, narcotic or controlled: every movement is in the drug register.',
    }),
    batches: Type.Array(ref(UsableBatchView), {
      description:
        'In date with stock at the place, nearest expiry first. One with no price cannot be sold.',
    }),
  },
  {
    $id: 'SaleItemOptions',
    description: 'An item that may be sold at a place, with its batches.',
  },
);
export type SaleItemOptions = Static<typeof SaleItemOptions>;

const BatchQuantity = Type.Object(
  {
    batchId: Id,
    quantity: Type.Integer({ minimum: 1, maximum: QUANTITY_MAX }),
  },
  { additionalProperties: false },
);

export const SaleCreate = Type.Object(
  {
    locationId: Id,
    patientId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'The registered patient the sale is for: one the caller may read. Required when an item needs a prescription; absent sells to anyone.',
      }),
    ),
    prescriberName: Type.Optional(
      Type.String({ minLength: 1, maxLength: PRESCRIBER_NAME_MAX, pattern: PLAIN_TEXT }),
    ),
    prescriberRegistration: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: PRESCRIBER_REGISTRATION_MAX,
        pattern: PLAIN_TEXT,
        description: 'The prescriber’s medical council registration number.',
      }),
    ),
    prescribedOn: Type.Optional(
      Type.String({
        pattern: '^\\d{4}-\\d{2}-\\d{2}$',
        description:
          'The outside prescription’s date, `YYYY-MM-DD`, not after today at the hospital. The three prescription fields come together or not at all, and are required when an item needs a prescription.',
      }),
    ),
    lines: Type.Array(
      Type.Object(
        {
          drugId: Id,
          batches: Type.Array(BatchQuantity, {
            minItems: 1,
            maxItems: BATCHES_MAX,
            description: 'Each batch once.',
          }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: SALE_ITEMS_MAX, description: 'Each item once.' },
    ),
  },
  { $id: 'SaleCreate', additionalProperties: false },
);
export type SaleCreate = Static<typeof SaleCreate>;

export const SaleLine = Type.Object(
  {
    id: Type.String(),
    lineNumber: Type.Integer(),
    drugId: Type.String(),
    itemName: Type.String({ description: 'The item as it read when sold.' }),
    schedule: Type.String(),
    controlled: Type.Boolean(),
    batchId: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    quantity: Type.Integer(),
    returnedQuantity: Type.Integer({ description: 'Units of the line brought back so far.' }),
    unitPriceMinor: Minor('The batch’s price of a unit when sold'),
  },
  { $id: 'SaleLine', description: 'Units of one batch of an item sold.' },
);

export const SaleReturn = Type.Object(
  {
    id: Type.String(),
    reason: Type.String(),
    totalMinor: Minor('What the units brought back were sold for'),
    returnedAt: Type.String({ format: 'date-time' }),
    returnedByName: Type.String(),
    lines: Type.Array(Type.Object({ saleLineId: Type.String(), quantity: Type.Integer() })),
  },
  { $id: 'SaleReturn', description: 'Units of a sale brought back into stock. Never changed.' },
);

export const PharmacySale = Type.Object(
  {
    id: Type.String(),
    locationId: Type.String(),
    locationName: Type.String(),
    patientId: Type.Optional(Type.String()),
    patientName: Type.Optional(Type.String()),
    patientMrn: Type.Optional(Type.String()),
    prescriberName: Type.Optional(Type.String()),
    prescriberRegistration: Type.Optional(Type.String()),
    prescribedOn: Type.Optional(CalendarDate),
    totalMinor: Minor('The sum of its lines'),
    returnedMinor: Minor('The sum of its returns'),
    soldAt: Type.String({ format: 'date-time' }),
    soldByName: Type.String(),
    lines: Type.Array(ref(SaleLine)),
    returns: Type.Array(ref(SaleReturn), { description: 'Oldest first.' }),
  },
  {
    $id: 'PharmacySale',
    description: 'A counter sale, with its lines and returns. Never changed or removed.',
  },
);
export type PharmacySale = Static<typeof PharmacySale>;

export const SalesQuery = Type.Object({
  days: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: SALES_DAYS_MAX,
      description: `Sold within this many days at the hospital, today included. Default ${SALES_DAYS_DEFAULT}.`,
    }),
  ),
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
});
export type SalesQuery = Static<typeof SalesQuery>;

export const SaleListItem = Type.Object(
  {
    id: Type.String(),
    soldAt: Type.String({ format: 'date-time' }),
    soldByName: Type.String(),
    locationName: Type.String(),
    patientId: Type.Optional(Type.String()),
    patientName: Type.Optional(Type.String()),
    patientMrn: Type.Optional(Type.String()),
    lineCount: Type.Integer(),
    totalMinor: Minor('The sum of its lines'),
    returnedMinor: Minor('The sum of its returns'),
  },
  { $id: 'SaleListItem', description: 'A counter sale in the list.' },
);
export type SaleListItem = Static<typeof SaleListItem>;

export const SalePage = CursorPage(ref(SaleListItem), { $id: 'SalePage' });

export const SaleReturnCreate = Type.Object(
  {
    reason: Type.String({ minLength: 1, maxLength: REASON_MAX, pattern: PLAIN_TEXT }),
    lines: Type.Array(
      Type.Object(
        {
          saleLineId: Id,
          quantity: Type.Integer({ minimum: 1, maximum: QUANTITY_MAX }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: SALE_ITEMS_MAX * BATCHES_MAX, description: 'Each line once.' },
    ),
  },
  { $id: 'SaleReturnCreate', additionalProperties: false },
);
export type SaleReturnCreate = Static<typeof SaleReturnCreate>;

export const RegisterQuery = Type.Object({
  drugId: Type.String({ description: 'An item of the register: H1, X, narcotic or controlled.' }),
  from: Type.String({
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: 'The first day, `YYYY-MM-DD`, at the hospital.',
  }),
  to: Type.String({
    pattern: '^\\d{4}-\\d{2}-\\d{2}$',
    description: `The last day, \`YYYY-MM-DD\`, at most ${REGISTER_DAYS_MAX} days after the first.`,
  }),
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
});
export type RegisterQuery = Static<typeof RegisterQuery>;

export const RegisterEntry = Type.Object(
  {
    id: Type.String({ description: 'The ledger entry.' }),
    at: Type.String({ format: 'date-time' }),
    locationName: Type.String(),
    batchNumber: Type.String(),
    expiryDate: CalendarDate,
    quantity: Type.Integer({ description: 'Positive in, negative out.' }),
    balanceAfter: Type.Integer({ description: 'The batch’s stock at the place after it.' }),
    source: Type.String({
      description:
        '`adjustment`, `dispense`, `dispense_return`, `sale` or `sale_return` (the ledger’s source).',
    }),
    sourceId: Type.String(),
    reason: Type.String({ description: 'The ledger’s reason.' }),
    actorName: Type.String(),
    patientId: Type.Optional(Type.String()),
    patientName: Type.Optional(Type.String()),
    patientMrn: Type.Optional(Type.String()),
    prescriptionId: Type.Optional(
      Type.String({ description: 'The in-hospital prescription of a dispense.' }),
    ),
    prescriberName: Type.Optional(
      Type.String({ description: 'Who prescribed it: the hospital’s doctor, or an outside one.' }),
    ),
    prescriberRegistration: Type.Optional(
      Type.String({ description: 'An outside prescriber’s registration number.' }),
    ),
  },
  {
    $id: 'DrugRegisterEntry',
    description: 'A movement of a register item, from the stock ledger.',
  },
);
export type RegisterEntry = Static<typeof RegisterEntry>;

export const RegisterPage = CursorPage(ref(RegisterEntry), { $id: 'DrugRegisterPage' });

export const SALE_SCHEMAS = [
  SaleItemOptions,
  SaleCreate,
  SaleLine,
  SaleReturn,
  PharmacySale,
  SaleListItem,
  SalePage,
  SaleReturnCreate,
  RegisterEntry,
  RegisterPage,
] as const;
