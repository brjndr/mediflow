import { Type, type Static } from '@sinclair/typebox';
import { ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { METHODS, REASON_MAX, SOURCES } from './schemas.js';

export const ESTIMATE_NOTE_MAX = 300;
export const DEPOSIT_REFERENCE_MAX = 100;
export const DISCHARGE_POLICY_MODES = ['off', 'warn', 'block'] as const;
export const CLEARANCE_REASONS = [
  'unbilled',
  'draft_invoice',
  'balance_due',
  'excess_deposit',
] as const;

const Minor = (description: string) => Type.Integer({ description });
const AdmissionStatus = StringEnum(['admitted', 'discharged', 'cancelled']);

export const StayParams = Type.Object({ admissionId: Type.String({ maxLength: 64 }) });

export const RunningBillPart = Type.Object(
  {
    serviceId: Type.String(),
    name: Type.String(),
    days: Type.Integer({ minimum: 0 }),
    unitPriceMinor: Type.Integer({ minimum: 0 }),
    totalMinor: Type.Integer(),
  },
  {
    $id: 'RunningBillPart',
    additionalProperties: false,
    description: 'Bed days at one bed-day service and one day price (a stretch of the stay).',
  },
);

export const RunningBillLine = Type.Object(
  {
    source: StringEnum(SOURCES),
    count: Type.Integer({
      minimum: 0,
      description: 'Charges in the line; for bed days, the days.',
    }),
    totalMinor: Type.Integer(),
    accruing: Type.Optional(
      Type.Boolean({
        description: 'True for bed days accrued to date that are not a ledger charge yet.',
      }),
    ),
    parts: Type.Optional(
      Type.Array(ref(RunningBillPart), {
        description:
          'Bed line only: the days split by bed-day service and the day price in effect on each day, posted and accrued together.',
      }),
    ),
  },
  { $id: 'RunningBillLine', additionalProperties: false },
);

export const RunningBill = Type.Object(
  {
    admissionId: Type.String(),
    encounterId: Type.String(),
    asOf: Type.String({ format: 'date-time' }),
    lines: Type.Array(ref(RunningBillLine)),
    chargesMinor: Minor('The sum of the lines (void charges left out).'),
    invoicedMinor: Type.Integer(),
    paidMinor: Minor('Paid on the invoices, deposits set against an invoice left out.'),
    depositsMinor: Minor('Deposits taken, less those paid back.'),
    balanceMinor: Minor(
      'Charges less deposits and payments; negative when the patient is in credit.',
    ),
    estimateMinor: Type.Optional(Type.Integer({ minimum: 0 })),
    estimateNote: Type.Optional(Type.String({ maxLength: ESTIMATE_NOTE_MAX })),
    patientName: Type.String(),
    patientMrn: Type.String(),
    status: AdmissionStatus,
  },
  {
    $id: 'RunningBill',
    additionalProperties: false,
    description:
      'The running bill of an inpatient stay: the charge ledger of its encounter by source, bed days accrued but not yet posted, deposits and payments.',
  },
);

export const BillEstimateSet = Type.Object(
  {
    amountMinor: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    note: Type.Optional(Type.String({ maxLength: ESTIMATE_NOTE_MAX, pattern: PLAIN_TEXT })),
  },
  { $id: 'BillEstimateSet', additionalProperties: false },
);

export const DepositCreate = Type.Object(
  {
    amountMinor: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    method: StringEnum(METHODS),
    reference: Type.Optional(
      Type.String({ minLength: 1, maxLength: DEPOSIT_REFERENCE_MAX, pattern: PLAIN_TEXT }),
    ),
  },
  { $id: 'DepositCreate', additionalProperties: false },
);

export const Deposit = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    admissionId: Type.String(),
    amountMinor: Type.Integer(),
    method: StringEnum(METHODS),
    reference: Type.Optional(Type.String()),
    recordedByName: Type.String(),
    at: Type.String({ format: 'date-time' }),
  },
  { $id: 'Deposit', additionalProperties: false },
);

export const DepositList = Type.Object(
  { items: Type.Array(ref(Deposit)) },
  { $id: 'DepositList', additionalProperties: false },
);

export const DischargePolicy = Type.Object(
  { mode: StringEnum(DISCHARGE_POLICY_MODES) },
  {
    $id: 'DischargePolicy',
    additionalProperties: false,
    description:
      'How the hospital gates discharge on the bill: off, warn (the person discharging confirms they have seen it) or block (nothing owed or unbilled).',
  },
);

export const DepositApply = Type.Object(
  { invoiceId: Type.String({ maxLength: 64 }) },
  { $id: 'DepositApply', additionalProperties: false },
);

export const DepositRefund = Type.Object(
  {
    amountMinor: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
    method: StringEnum(METHODS),
    reason: Type.String({ minLength: 1, maxLength: REASON_MAX, pattern: PLAIN_TEXT }),
  },
  { $id: 'DepositRefund', additionalProperties: false },
);

export const StaySettlementInvoice = Type.Object(
  {
    id: Type.String(),
    number: Type.Optional(Type.String()),
    status: StringEnum(['draft', 'issued', 'paid', 'void']),
    totalMinor: Type.Integer(),
    creditedMinor: Type.Integer(),
    paidMinor: Type.Integer(),
  },
  { $id: 'StaySettlementInvoice', additionalProperties: false },
);

export const StaySettlement = Type.Object(
  {
    admissionId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    status: AdmissionStatus,
    chargesMinor: Minor('Every charge of the stay in the ledger, void ones left out.'),
    unbilledMinor: Minor('Charges not on an issued invoice yet.'),
    invoicedMinor: Minor('The totals of the stay’s issued and paid invoices, before credit notes.'),
    creditedMinor: Type.Integer(),
    paidMinor: Minor('Paid on the invoices, deposits applied included.'),
    dueMinor: Type.Integer(),
    depositsMinor: Minor('Every deposit taken.'),
    depositsAppliedMinor: Type.Integer(),
    depositsRefundedMinor: Type.Integer(),
    depositsHeldMinor: Minor('Taken, less applied and refunded.'),
    excessDepositMinor: Minor(
      'Held beyond what is due, with nothing left to invoice: what may be refunded.',
    ),
    invoices: Type.Array(ref(StaySettlementInvoice)),
    policy: StringEnum(DISCHARGE_POLICY_MODES),
    clearance: Type.Object(
      {
        cleared: Type.Boolean(),
        reasons: Type.Array(StringEnum(CLEARANCE_REASONS)),
      },
      { additionalProperties: false },
    ),
  },
  { $id: 'StaySettlement', additionalProperties: false },
);

export type BillEstimateSet = Static<typeof BillEstimateSet>;
export type DepositCreate = Static<typeof DepositCreate>;
export type DepositApply = Static<typeof DepositApply>;
export type DepositRefund = Static<typeof DepositRefund>;
export type DischargePolicy = Static<typeof DischargePolicy>;

export const STAY_SCHEMAS = [
  RunningBillPart,
  RunningBillLine,
  RunningBill,
  BillEstimateSet,
  DepositCreate,
  Deposit,
  DepositList,
  DischargePolicy,
  DepositApply,
  DepositRefund,
  StaySettlementInvoice,
  StaySettlement,
] as const;
