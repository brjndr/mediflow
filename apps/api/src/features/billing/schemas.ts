import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { TAX_CLASSES } from './tax.js';

export const DESCRIPTION_MAX = 200;
export const REFERENCE_MAX = 60;
export const REASON_MAX = 200;
export const NOTE_MAX = 300;
/** The most a typed price may be: with the most units, a line stays a safe integer. */
export const PRICE_MAX = 100_000_000_000;

export const SOURCES = ['service', 'order', 'dispense', 'bed', 'procedure', 'manual'] as const;
export const METHODS = ['cash', 'card', 'upi', 'bank', 'other'] as const;
const Id = Type.String({ maxLength: 64 });
const Minor = (description: string) => Type.Integer({ minimum: 0, description });
const Positive = (description: string) =>
  Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER, description });

export const Charge = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    source: StringEnum(SOURCES),
    description: Type.String({ maxLength: DESCRIPTION_MAX }),
    quantity: Type.Integer({ minimum: 1 }),
    unitPriceMinor: Minor('Priced when posted; never changes.'),
    totalMinor: Minor('Quantity times the price of one.'),
    status: StringEnum(['pending', 'invoiced', 'void']),
    invoiceId: Type.Optional(
      Type.String({ description: 'The draft invoice holding the charge, when one does.' }),
    ),
    flag: Type.Optional(
      StringEnum(['service_archived', 'no_price', 'return_review'], {
        description:
          'For the billing desk: priced at the last price of an archived service, posted with no price, or brought back after dispensing.',
      }),
    ),
    taxClass: Type.Optional(
      StringEnum(TAX_CLASSES, {
        description:
          'The tax class the work was posted with; none for a dispensed medicine, whose price holds the tax.',
      }),
    ),
    postedAt: Type.String({ format: 'date-time' }),
  },
  {
    $id: 'Charge',
    additionalProperties: false,
    description:
      'Billable work posted to a visit. Priced when it was posted; never changes afterwards.',
  },
);
export type Charge = Static<typeof Charge>;
export const ChargePage = CursorPage(ref(Charge), { $id: 'ChargePage' });

export const ChargeCreate = Type.Object(
  {
    serviceId: Type.String({ maxLength: 64, description: 'A service of the price catalog.' }),
    quantity: Type.Integer({ minimum: 1, maximum: 9999 }),
  },
  {
    $id: 'ChargeCreate',
    additionalProperties: false,
    description:
      'A service to charge to a visit by hand. The price is the standard price list price in effect today, never typed.',
  },
);
export type ChargeCreate = Static<typeof ChargeCreate>;

export const ChargeQuery = Type.Object({
  status: Type.Optional(StringEnum(['pending', 'invoiced', 'void'])),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const InvoiceListQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
});

export const InvoiceSearch = Type.Object(
  {
    q: Type.Optional(
      Type.String({
        maxLength: 100,
        description:
          'Invoice number, patient name or MRN. Every word must match; only the first six words are used.',
      }),
    ),
    status: Type.Optional(StringEnum(['draft', 'issued', 'paid', 'void'])),
    from: Type.Optional(Type.String({ format: 'date-time' })),
    to: Type.Optional(Type.String({ format: 'date-time' })),
    cursor: Type.Optional(Type.String()),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
  },
  { $id: 'InvoiceSearch', additionalProperties: false },
);

export const ManualLine = Type.Object(
  {
    description: Type.String({ minLength: 1, maxLength: DESCRIPTION_MAX, pattern: PLAIN_TEXT }),
    quantity: Type.Integer({ minimum: 1, maximum: 9999 }),
    unitPriceMinor: Type.Integer({ minimum: 0, maximum: PRICE_MAX }),
    taxClass: Type.Optional(
      StringEnum(TAX_CLASSES, {
        description:
          'The class the line is taxed as, at the hospital’s rate for it when the draft is saved. Left out: no tax.',
      }),
    ),
  },
  {
    $id: 'ManualLine',
    additionalProperties: false,
    description: 'A line the billing desk types in: something not in the price catalog.',
  },
);
export type ManualLine = Static<typeof ManualLine>;

export const InvoiceLine = Type.Object(
  {
    id: Type.String(),
    chargeId: Type.Optional(Type.String()),
    source: StringEnum(SOURCES),
    description: Type.String(),
    quantity: Type.Integer({ minimum: 1 }),
    unitPriceMinor: Minor('In minor units.'),
    totalMinor: Minor('Quantity times the price of one, before tax.'),
    taxClass: Type.Optional(StringEnum(TAX_CLASSES)),
    taxRateBp: Type.Integer({
      minimum: 0,
      maximum: 10000,
      description: 'The rate the line was made with, in basis points (1200 is 12%).',
    }),
    taxMinor: Minor('The tax on the line, rounded half up; worked out by the server.'),
  },
  { $id: 'InvoiceLine', additionalProperties: false },
);
export type InvoiceLine = Static<typeof InvoiceLine>;

export const Invoice = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    number: Type.Optional(Type.String({ description: 'Given when the invoice is issued.' })),
    status: StringEnum(['draft', 'issued', 'paid', 'void']),
    lines: Type.Array(ref(InvoiceLine)),
    totalMinor: Minor('What is owed: the lines and their tax, worked out by the server.'),
    taxMinor: Minor('The part of the total that is tax; never changes once issued.'),
    paidMinor: Minor('Payments less refunds.'),
    creditedMinor: Minor('The credit notes against the invoice.'),
    currency: Type.String({ minLength: 3, maxLength: 3 }),
    createdAt: Type.String({ format: 'date-time' }),
    issuedAt: Type.Optional(Type.String({ format: 'date-time' })),
    version: Type.Integer({ minimum: 1 }),
  },
  {
    $id: 'Invoice',
    additionalProperties: false,
    description: 'A bill of one visit. A draft can be changed; once issued it never is.',
  },
);
export type Invoice = Static<typeof Invoice>;
export const InvoicePage = CursorPage(ref(Invoice), { $id: 'InvoicePage' });

export const InvoiceContent = Type.Object(
  {
    chargeIds: Type.Array(Id, { maxItems: 200 }),
    manualLines: Type.Array(ref(ManualLine), { maxItems: 50 }),
  },
  {
    $id: 'InvoiceContent',
    additionalProperties: false,
    description:
      'What a draft is made of: pending charges of the visit, and lines typed in (these need invoice:adjust).',
  },
);
export type InvoiceContent = Static<typeof InvoiceContent>;

export const InvoiceUpdate = Type.Object(
  {
    chargeIds: Type.Array(Id, { maxItems: 200 }),
    manualLines: Type.Array(ref(ManualLine), { maxItems: 50 }),
    version: Type.Integer({ minimum: 1 }),
  },
  { $id: 'InvoiceUpdate', additionalProperties: false },
);
export type InvoiceUpdate = Static<typeof InvoiceUpdate>;

export const InvoiceIssue = Type.Object(
  { version: Type.Integer({ minimum: 1 }) },
  { $id: 'InvoiceIssue', additionalProperties: false },
);

export const Payment = Type.Object(
  {
    id: Type.String(),
    invoiceId: Type.String(),
    kind: StringEnum(['payment', 'refund']),
    amountMinor: Positive('In minor units.'),
    method: StringEnum(METHODS),
    reference: Type.Optional(Type.String()),
    refundOf: Type.Optional(Type.String({ description: 'The payment a refund is of.' })),
    reason: Type.Optional(Type.String()),
    sessionId: Type.Optional(
      Type.String({ description: 'The register session of a cash payment.' }),
    ),
    recordedByName: Type.String(),
    at: Type.String({ format: 'date-time' }),
  },
  { $id: 'Payment', additionalProperties: false },
);
export type Payment = Static<typeof Payment>;
export const PaymentList = Type.Object(
  { items: Type.Array(ref(Payment)) },
  { $id: 'PaymentList', description: 'Every payment and refund of an invoice, oldest first.' },
);

export const PaymentCreate = Type.Object(
  {
    amountMinor: Positive('At most what is still due.'),
    method: StringEnum(METHODS),
    reference: Type.Optional(
      Type.String({ minLength: 1, maxLength: REFERENCE_MAX, pattern: PLAIN_TEXT }),
    ),
  },
  { $id: 'PaymentCreate', additionalProperties: false },
);
export type PaymentCreate = Static<typeof PaymentCreate>;

export const RefundCreate = Type.Object(
  {
    amountMinor: Positive('At most what the payment still holds.'),
    reason: Type.String({ minLength: 1, maxLength: REASON_MAX, pattern: PLAIN_TEXT }),
  },
  { $id: 'RefundCreate', additionalProperties: false },
);
export type RefundCreate = Static<typeof RefundCreate>;

export const CreditNote = Type.Object(
  {
    id: Type.String(),
    invoiceId: Type.String(),
    number: Type.String(),
    amountMinor: Positive('In minor units.'),
    reason: Type.String(),
    createdByName: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'CreditNote', additionalProperties: false },
);
export type CreditNote = Static<typeof CreditNote>;
export const CreditNoteList = Type.Object(
  { items: Type.Array(ref(CreditNote)) },
  { $id: 'CreditNoteList' },
);

export const CreditNoteCreate = Type.Object(
  {
    amountMinor: Positive('At most what is left of the invoice after earlier credit notes.'),
    reason: Type.String({ minLength: 1, maxLength: REASON_MAX, pattern: PLAIN_TEXT }),
  },
  { $id: 'CreditNoteCreate', additionalProperties: false },
);
export type CreditNoteCreate = Static<typeof CreditNoteCreate>;

export const RegisterTotal = Type.Object(
  { method: StringEnum(METHODS), paidMinor: Minor('Taken.'), refundedMinor: Minor('Refunded.') },
  { $id: 'RegisterTotal', additionalProperties: false },
);

export const RegisterSession = Type.Object(
  {
    id: Type.String(),
    openedByName: Type.String(),
    openedAt: Type.String({ format: 'date-time' }),
    openingMinor: Minor('Cash in the drawer at the start.'),
    closedAt: Type.Optional(Type.String({ format: 'date-time' })),
    expectedMinor: Type.Integer({
      description: 'Opening cash plus cash taken, less cash refunded: so far while open.',
    }),
    countedMinor: Type.Optional(Minor('Counted at settlement.')),
    differenceMinor: Type.Optional(
      Type.Integer({ description: 'Counted less expected: negative when cash is short.' }),
    ),
    note: Type.Optional(Type.String()),
    totals: Type.Array(ref(RegisterTotal), { description: 'By method.' }),
  },
  { $id: 'RegisterSession', additionalProperties: false },
);
export type RegisterSession = Static<typeof RegisterSession>;
export const RegisterSessionPage = CursorPage(ref(RegisterSession), {
  $id: 'RegisterSessionPage',
});

export const RegisterOpen = Type.Object(
  { openingMinor: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }) },
  { $id: 'RegisterOpen', additionalProperties: false },
);
export type RegisterOpen = Static<typeof RegisterOpen>;
export const RegisterClose = Type.Object(
  {
    countedMinor: Type.Integer({ minimum: 0, maximum: 1_000_000_000_000 }),
    note: Type.Optional(Type.String({ minLength: 1, maxLength: NOTE_MAX, pattern: PLAIN_TEXT })),
  },
  { $id: 'RegisterClose', additionalProperties: false },
);
export type RegisterClose = Static<typeof RegisterClose>;

export const TaxRate = Type.Object(
  {
    taxClass: StringEnum(TAX_CLASSES),
    rateBp: Type.Integer({
      minimum: 0,
      maximum: 10000,
      description: 'In basis points: 1200 is 12%.',
    }),
  },
  { $id: 'TaxRate', additionalProperties: false },
);
export type TaxRate = Static<typeof TaxRate>;

export const TaxRates = Type.Object(
  {
    items: Type.Array(ref(TaxRate), {
      description: 'The rate of every tax class: the hospital’s own where set, else the default.',
    }),
  },
  { $id: 'TaxRates' },
);

export const TaxRatesUpdate = Type.Object(
  { items: Type.Array(ref(TaxRate), { minItems: 1, maxItems: 4 }) },
  {
    $id: 'TaxRatesUpdate',
    additionalProperties: false,
    description:
      'The rates to set, each class once. A class left out keeps its rate. Drafts take the new rates when next saved; issued invoices never change.',
  },
);
export type TaxRatesUpdate = Static<typeof TaxRatesUpdate>;

export const BILLING_SCHEMAS = [
  Charge,
  ChargePage,
  ChargeCreate,
  ManualLine,
  InvoiceLine,
  Invoice,
  InvoicePage,
  InvoiceSearch,
  InvoiceContent,
  InvoiceUpdate,
  InvoiceIssue,
  Payment,
  PaymentList,
  PaymentCreate,
  RefundCreate,
  CreditNote,
  CreditNoteList,
  CreditNoteCreate,
  RegisterTotal,
  RegisterSession,
  RegisterSessionPage,
  RegisterOpen,
  RegisterClose,
  TaxRate,
  TaxRates,
  TaxRatesUpdate,
];
