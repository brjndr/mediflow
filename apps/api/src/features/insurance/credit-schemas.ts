import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

/**
 * The corporate credit contract (BE-28d, #803). The shapes are the ones the web app was built
 * against in `planned.openapi.json`.
 */

const Minor = Type.Integer({ minimum: 0 });
const Day = (description?: string) =>
  Type.String({
    format: 'date',
    pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$',
    ...(description ? { description } : {}),
  });

export const CreditAccount = Type.Object(
  {
    payerId: Type.String(),
    payerName: Type.String(),
    creditLimitMinor: Minor,
    termsDays: Type.Integer({ minimum: 0, maximum: 365 }),
    billedMinor: Minor,
    receivedMinor: Minor,
    outstandingMinor: Type.Integer({ minimum: 0, description: 'Billed less received.' }),
    overdueMinor: Type.Integer({
      minimum: 0,
      description: 'Outstanding on bills past their due day.',
    }),
    availableMinor: Type.Integer({
      minimum: 0,
      description: 'The limit less what is outstanding.',
    }),
    version: Type.Integer({ minimum: 1 }),
  },
  { $id: 'CreditAccount' },
);
export type CreditAccount = Static<typeof CreditAccount>;

export const CreditAccountPage = CursorPage(ref(CreditAccount), { $id: 'CreditAccountPage' });

export const CreditAccountWrite = Type.Object(
  {
    creditLimitMinor: Type.Integer({ minimum: 0, maximum: 2_000_000_000 }),
    termsDays: Type.Integer({ minimum: 0, maximum: 365 }),
    version: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { $id: 'CreditAccountWrite', additionalProperties: false },
);

export const CREDIT_BILL_STATUSES = ['open', 'part_paid', 'paid'] as const;
const CreditBillStatusSchema = Type.Unsafe<(typeof CREDIT_BILL_STATUSES)[number]>({
  $id: 'CreditBillStatus',
  type: 'string',
  enum: [...CREDIT_BILL_STATUSES],
});

export const CreditBill = Type.Object(
  {
    id: Type.String(),
    number: Type.String(),
    payerId: Type.String(),
    payerName: Type.String(),
    encounterId: Type.String(),
    issuedOn: Day(),
    dueOn: Day(),
    amountMinor: Minor,
    receivedMinor: Minor,
    outstandingMinor: Minor,
    status: ref(CreditBillStatusSchema),
    overdue: Type.Boolean(),
  },
  { $id: 'CreditBill' },
);
export type CreditBill = Static<typeof CreditBill>;

export const CreditBillPage = CursorPage(ref(CreditBill), { $id: 'CreditBillPage' });

export const CreditBillCreate = Type.Object(
  { payerId: Type.String({ maxLength: 64 }) },
  { $id: 'CreditBillCreate', additionalProperties: false },
);

export const StatementLine = Type.Object(
  {
    id: Type.String(),
    on: Day(),
    kind: StringEnum(['bill', 'receipt'] as const),
    number: Type.String(),
    debitMinor: Minor,
    creditMinor: Minor,
    balanceMinor: Minor,
  },
  { $id: 'StatementLine' },
);

export const CreditStatement = Type.Object(
  {
    payerId: Type.String(),
    payerName: Type.String(),
    from: Day(),
    to: Day(),
    openingMinor: Minor,
    billedMinor: Minor,
    receivedMinor: Minor,
    closingMinor: Minor,
    items: Type.Array(ref(StatementLine)),
    nextCursor: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: 'CreditStatement' },
);

export const RECEIPT_METHODS = ['cash', 'bank_transfer', 'cheque', 'card'] as const;
const ReceiptMethodSchema = Type.Unsafe<(typeof RECEIPT_METHODS)[number]>({
  $id: 'ReceiptMethod',
  type: 'string',
  enum: [...RECEIPT_METHODS],
});

export const ReceiptAllocation = Type.Object(
  { billId: Type.String(), billNumber: Type.String(), amountMinor: Minor },
  { $id: 'ReceiptAllocation' },
);

export const Receipt = Type.Object(
  {
    id: Type.String(),
    number: Type.String(),
    payerId: Type.String(),
    payerName: Type.String(),
    receivedOn: Day(),
    method: ref(ReceiptMethodSchema),
    reference: Type.Optional(Type.String({ maxLength: 60 })),
    amountMinor: Minor,
    allocations: Type.Array(ref(ReceiptAllocation)),
  },
  { $id: 'Receipt' },
);
export type Receipt = Static<typeof Receipt>;

export const ReceiptPage = CursorPage(ref(Receipt), { $id: 'ReceiptPage' });

export const ReceiptCreate = Type.Object(
  {
    amountMinor: Type.Integer({ minimum: 1, maximum: 2_000_000_000 }),
    method: ref(ReceiptMethodSchema),
    reference: Type.Optional(Type.String({ minLength: 1, maxLength: 60, pattern: PLAIN_TEXT })),
    receivedOn: Day(),
  },
  { $id: 'ReceiptCreate', additionalProperties: false },
);

const Cursor = Type.Optional(Type.String({ maxLength: 300 }));
const Limit = Type.Optional(
  Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
);
export const PageQuery = Type.Object({ cursor: Cursor, limit: Limit });
export const BillListQuery = Type.Object({
  status: Type.Optional(ref(CreditBillStatusSchema)),
  cursor: Cursor,
  limit: Limit,
});
export const StatementQuery = Type.Object({ from: Day(), to: Day(), cursor: Cursor, limit: Limit });
export const CreditPayerParams = Type.Object({ payerId: Type.String({ maxLength: 64 }) });

export const CREDIT_SCHEMAS = [
  CreditAccount,
  CreditAccountPage,
  CreditAccountWrite,
  CreditBillStatusSchema,
  CreditBill,
  CreditBillPage,
  CreditBillCreate,
  StatementLine,
  CreditStatement,
  ReceiptMethodSchema,
  ReceiptAllocation,
  Receipt,
  ReceiptPage,
  ReceiptCreate,
];
