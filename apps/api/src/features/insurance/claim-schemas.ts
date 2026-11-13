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
 * The coverage split and claims contract (BE-28, #187, second slice). The shapes are the ones the
 * web app was built against in `planned.openapi.json`.
 */

const Version = Type.Integer({ minimum: 1 });
const Minor = Type.Integer({ minimum: 0 });
const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: PLAIN_TEXT });
const Names = Type.Array(Text(100), { maxItems: 20 });

// --- coverage split ----------------------------------------------------------------------------

export const SPLIT_REASONS = [
  'covered',
  'copay',
  'not_covered',
  'service_limit',
  'sum_insured',
] as const;

export const CoverageSplitLine = Type.Object(
  {
    chargeId: Type.String(),
    description: Type.String({ maxLength: 200 }),
    ledgerMinor: Type.Integer({ description: 'The charge as posted, at the list price.' }),
    ratedMinor: Type.Integer({ description: "The charge at the payer's agreed rate." }),
    payerMinor: Minor,
    patientMinor: Minor,
    reason: StringEnum(SPLIT_REASONS),
  },
  { $id: 'CoverageSplitLine' },
);
export type CoverageSplitLine = Static<typeof CoverageSplitLine>;

export const CoverageSplit = Type.Object(
  {
    encounterId: Type.String(),
    policyId: Type.String(),
    payerName: Type.String(),
    planName: Type.String(),
    agreementName: Type.Optional(
      Type.String({ description: 'The rate agreement that priced the lines, when one runs.' }),
    ),
    copayPercent: Type.Integer({ minimum: 0, maximum: 100 }),
    lines: Type.Array(ref(CoverageSplitLine)),
    ledgerMinor: Type.Integer({
      description: "The visit's charges, void ones left out, at list price.",
    }),
    rateAdjustmentMinor: Type.Integer({
      description: 'Rated total less ledger total; negative when the agreement is cheaper.',
    }),
    payerMinor: Minor,
    patientMinor: Minor,
    saved: Type.Optional(
      Type.Object({
        savedAt: Type.String({ format: 'date-time' }),
        ledgerMinor: Type.Integer(),
        payerMinor: Type.Integer(),
        patientMinor: Type.Integer(),
      }),
    ),
    stale: Type.Boolean({
      description: 'A saved split exists and the ledger has changed since.',
    }),
  },
  { $id: 'CoverageSplit' },
);
export type CoverageSplit = Static<typeof CoverageSplit>;

export const SplitSaveHeaders = Type.Object({
  'idempotency-key': Type.String({ minLength: 1, maxLength: 128 }),
});

// --- claims ------------------------------------------------------------------------------------

export const CLAIM_STATUSES = [
  'draft',
  'submitted',
  'query',
  'approved',
  'rejected',
  'settled',
  'written_off',
  'cancelled',
] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const CLAIM_ACTIONS = [
  'submit',
  'raise_query',
  'reply',
  'approve',
  'reject',
  'settle',
  'write_off',
  'cancel',
] as const;
export type ClaimActionKind = (typeof CLAIM_ACTIONS)[number];

export const ClaimStatusSchema = Type.Unsafe<ClaimStatus>({
  $id: 'ClaimStatus',
  type: 'string',
  enum: [...CLAIM_STATUSES],
});
export const ClaimActionKindSchema = Type.Unsafe<ClaimActionKind>({
  $id: 'ClaimActionKind',
  type: 'string',
  enum: [...CLAIM_ACTIONS],
});

const claimProperties = {
  id: Type.String(),
  number: Type.String({ description: 'The hospital claim number.' }),
  patientId: Type.String(),
  encounterId: Type.String(),
  policyId: Type.String(),
  payerId: Type.String(),
  payerName: Type.String(),
  policyNumber: Type.String(),
  claimedMinor: Type.Integer({
    minimum: 0,
    description: 'The payer share of the visit split when the claim was prepared.',
  }),
  approvedMinor: Type.Optional(
    Type.Integer({
      minimum: 0,
      description: 'What the payer agreed to pay. Absent until approved.',
    }),
  ),
  receivedMinor: Type.Integer({ minimum: 0, description: 'What the payer has paid.' }),
  writtenOffMinor: Type.Integer({ minimum: 0, description: 'What the hospital gave up.' }),
  outstandingMinor: Type.Integer({
    minimum: 0,
    description:
      'Claimed less received and written off, worked out by the server. Zero for a draft or a withdrawn claim.',
  }),
  status: ref(ClaimStatusSchema),
  referenceNumber: Type.Optional(Text(60)),
  openQuery: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: 500,
      description: 'The payer question while the claim is in query.',
    }),
  ),
  documents: Type.Array(Text(100), {
    maxItems: 20,
    description: 'The packet, by name. The files are on the patient record.',
  }),
  createdAt: Type.String({ format: 'date-time' }),
  submittedAt: Type.Optional(Type.String({ format: 'date-time' })),
  decidedAt: Type.Optional(Type.String({ format: 'date-time' })),
  version: Version,
};

export const Claim = Type.Object(claimProperties, { $id: 'Claim' });
export type Claim = Static<typeof Claim>;

export const ClaimEvent = Type.Object(
  {
    at: Type.String({ format: 'date-time' }),
    action: StringEnum(['create', ...CLAIM_ACTIONS] as const),
    toStatus: ref(ClaimStatusSchema),
    amountMinor: Type.Optional(Minor),
    note: Type.Optional(Text(500)),
  },
  { $id: 'ClaimEvent' },
);
export type ClaimEvent = Static<typeof ClaimEvent>;

export const ClaimDetail = Type.Object(
  {
    ...claimProperties,
    events: Type.Array(ref(ClaimEvent)),
    allowedActions: Type.Array(ref(ClaimActionKindSchema), {
      description: 'What can be done to the claim now, from the state machine.',
    }),
  },
  { $id: 'ClaimDetail' },
);
export type ClaimDetail = Static<typeof ClaimDetail>;

export const ClaimPage = CursorPage(ref(Claim), { $id: 'ClaimPage' });

export const ClaimCreate = Type.Object(
  { documents: Names, note: Type.Optional(Text(500)) },
  { $id: 'ClaimCreate', additionalProperties: false },
);
export type ClaimCreate = Static<typeof ClaimCreate>;

export const ClaimAction = Type.Object(
  {
    version: Version,
    action: ref(ClaimActionKindSchema),
    note: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        pattern: PLAIN_TEXT,
        description:
          'Required for raise_query (the question), reply, reject and write_off (the reason).',
      }),
    ),
    approvedMinor: Type.Optional(
      Type.Integer({ minimum: 0, description: 'Required for approve.' }),
    ),
    receivedMinor: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: 'Required for settle: the payment that came in, at most the approved amount.',
      }),
    ),
    referenceNumber: Type.Optional(Text(60)),
    documents: Type.Optional(
      Type.Array(Text(100), { maxItems: 20, description: 'Added to the packet with a reply.' }),
    ),
  },
  { $id: 'ClaimAction', additionalProperties: false },
);
export type ClaimAction = Static<typeof ClaimAction>;

const buckets = Type.Array(Minor, {
  minItems: 4,
  maxItems: 4,
  description:
    'Outstanding money aged 0 to 30, 31 to 60, 61 to 90 and over 90 days from submission.',
});

export const ClaimAgingRow = Type.Object(
  {
    payerId: Type.String(),
    payerName: Type.String(),
    claims: Type.Integer({ minimum: 0 }),
    buckets,
    outstandingMinor: Minor,
  },
  { $id: 'ClaimAgingRow' },
);

export const ClaimAgingTotals = Type.Object(
  { claims: Type.Integer({ minimum: 0 }), buckets, outstandingMinor: Minor },
  { $id: 'ClaimAgingTotals' },
);

export const ClaimAging = Type.Object(
  {
    asOf: Type.String({ format: 'date-time' }),
    rows: Type.Array(ref(ClaimAgingRow)),
    totals: ref(ClaimAgingTotals),
  },
  { $id: 'ClaimAging' },
);

export const ClaimListQuery = Type.Object({
  status: Type.Optional(StringEnum(CLAIM_STATUSES)),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});
export const ClaimParams = Type.Object({ claimId: Type.String({ maxLength: 64 }) });

export const CLAIM_SCHEMAS = [
  CoverageSplitLine,
  CoverageSplit,
  ClaimStatusSchema,
  ClaimActionKindSchema,
  Claim,
  ClaimEvent,
  ClaimDetail,
  ClaimPage,
  ClaimCreate,
  ClaimAction,
  ClaimAgingRow,
  ClaimAgingTotals,
  ClaimAging,
];
