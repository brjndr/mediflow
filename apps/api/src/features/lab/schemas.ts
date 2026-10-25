import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';
import { OrderPriority, OrderStatus } from '../clinical/index.js';

// The enums carry an $id, unlike `StringEnum`, so the contract names them as the web app does.
const named = <const Values extends readonly string[]>(
  $id: string,
  values: Values,
  description?: string,
) =>
  Type.Unsafe<Values[number]>({
    $id,
    type: 'string',
    enum: [...values],
    ...(description ? { description } : {}),
  });

export const STAGES = ['to_collect', 'collected', 'received', 'completed'] as const;
export type LabStageValue = (typeof STAGES)[number];
export const LabStage = named(
  'LabStage',
  STAGES,
  'Where a lab order is in the laboratory: its sample still to collect (none yet, or the last one rejected), collected, received by the laboratory, or completed (every result verified; a correction may still be waiting to be verified).',
);

export const SAMPLE_STATUSES = ['collected', 'received', 'rejected'] as const;
export type LabSampleStatusValue = (typeof SAMPLE_STATUSES)[number];
export const LabSampleStatus = named('LabSampleStatus', SAMPLE_STATUSES);

export const REJECT_REASONS = [
  'haemolysed',
  'clotted',
  'insufficient',
  'mislabelled',
  'wrong_container',
  'contaminated',
  'other',
] as const;
export type LabRejectReasonValue = (typeof REJECT_REASONS)[number];
export const LabRejectReason = named('LabRejectReason', REJECT_REASONS);

export const RESULT_FLAGS = ['normal', 'low', 'high', 'critical_low', 'critical_high'] as const;
export type LabResultFlagValue = (typeof RESULT_FLAGS)[number];
export const LabResultFlag = named(
  'LabResultFlag',
  RESULT_FLAGS,
  'A number read against its reference range: at or below the critical low, or at or above the critical high, first; then below the low or above the high; else normal.',
);

export const RESULT_STATUSES = ['entered', 'verified'] as const;
export type LabResultStatusValue = (typeof RESULT_STATUSES)[number];
export const LabResultStatus = named(
  'LabResultStatus',
  RESULT_STATUSES,
  'Entered, then verified once: a verified result is released to the doctor.',
);

const SAMPLE_TYPE = {
  type: 'string',
  enum: ['blood', 'serum', 'plasma', 'urine', 'stool', 'swab', 'sputum', 'csf', 'tissue', 'other'],
} as const;
const SampleType = Type.Unsafe<(typeof SAMPLE_TYPE.enum)[number]>(SAMPLE_TYPE);
const ResultType = Type.Unsafe<'numeric' | 'text'>({ type: 'string', enum: ['numeric', 'text'] });

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({
  description: 'The version the change was made from. Another one gives 409 `conflict`.',
});

export const NOTE_MAX = 200;
export const REASON_MAX = 200;
export const VALUE_MAX = 500;
export const COMMENT_MAX = 500;
export const RESULTS_MAX = 60;

export const LabSample = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    orderId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    accessionId: Type.String({
      description:
        'Unique in the hospital: `YYMMDD-NNNN`, numbered within the hospital day. What the label carries as a barcode.',
    }),
    sampleType: SampleType,
    container: Type.Optional(Type.String()),
    status: ref(LabSampleStatus),
    collectedAt: Type.String({ format: 'date-time' }),
    collectedByName: Type.String(),
    receivedAt: Type.Optional(Type.String({ format: 'date-time' })),
    receivedByName: Type.Optional(Type.String()),
    rejectedAt: Type.Optional(Type.String({ format: 'date-time' })),
    rejectedByName: Type.Optional(Type.String()),
    rejectReason: Type.Optional(ref(LabRejectReason)),
    rejectNote: Type.Optional(Type.String()),
    version: Type.Integer(),
  },
  {
    $id: 'LabSample',
    description:
      'One sample of a lab order. Never removed: a rejected one stays, and a new one is collected.',
  },
);
export type LabSample = Static<typeof LabSample>;

export const LabWorkItem = Type.Object(
  {
    orderId: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    patientDob: Type.Optional(
      Type.String({
        format: 'date',
        description: 'A calendar date, to tell the patient apart when the sample is taken.',
      }),
    ),
    labTestId: Type.Optional(Type.String()),
    itemCode: Type.Optional(Type.String()),
    itemName: Type.String(),
    priority: ref(OrderPriority),
    instructions: Type.Optional(Type.String()),
    placedAt: Type.String({ format: 'date-time' }),
    orderedByName: Type.String(),
    orderStatus: ref(OrderStatus),
    sampleType: SampleType,
    container: Type.Optional(Type.String()),
    stage: ref(LabStage),
    sample: Type.Optional(ref(LabSample)),
    rejectedSamples: Type.Integer({
      minimum: 0,
      description: 'How many samples of the order were rejected.',
    }),
    resultsEntered: Type.Integer({
      minimum: 0,
      description: 'How many tests of the current sample have a current result, verified or not.',
    }),
    resultsToVerify: Type.Integer({
      minimum: 0,
      description: 'How many of those are entered and not yet verified.',
    }),
  },
  {
    $id: 'LabWorkItem',
    description: 'A lab order as the laboratory works it, with its current sample.',
  },
);
export type LabWorkItem = Static<typeof LabWorkItem>;

export const LabWorkItemPage = CursorPage(ref(LabWorkItem), { $id: 'LabWorkItemPage' });

export const WorklistQuery = Type.Object({
  stage: Type.Optional(ref(LabStage)),
  priority: Type.Optional(ref(OrderPriority)),
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});
export type WorklistQuery = Static<typeof WorklistQuery>;

export const OrderParams = Type.Object({ orderId: Id });
export const SampleParams = Type.Object({ sampleId: Id });
export const ResultParams = Type.Object({ resultId: Id });

export const LabSampleReceive = Type.Object(
  { version: Version },
  { $id: 'LabSampleReceive', additionalProperties: false },
);
export type LabSampleReceive = Static<typeof LabSampleReceive>;

export const LabSampleReject = Type.Object(
  {
    version: Version,
    reason: ref(LabRejectReason),
    note: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: NOTE_MAX,
        pattern: PLAIN_TEXT,
        description: 'Required when the reason is `other`.',
      }),
    ),
  },
  { $id: 'LabSampleReject', additionalProperties: false },
);
export type LabSampleReject = Static<typeof LabSampleReject>;

export const LabRange = Type.Object(
  {
    low: Type.Optional(Type.Number()),
    high: Type.Optional(Type.Number()),
    criticalLow: Type.Optional(Type.Number()),
    criticalHigh: Type.Optional(Type.Number()),
    note: Type.Optional(Type.String()),
  },
  {
    $id: 'LabResultRange',
    description:
      'The reference range for the patient: the one of the test for their sex and their age on the day the sample was collected.',
  },
);

export const LabAnalyte = Type.Object(
  {
    labTestId: Type.String(),
    code: Type.String(),
    name: Type.String(),
    resultType: ResultType,
    unit: Type.Optional(Type.String()),
    range: Type.Optional(ref(LabRange)),
  },
  {
    $id: 'LabAnalyte',
    description:
      'What a result is entered for: the test ordered, or each test of the panel ordered, as the catalog has them now, in the order reported.',
  },
);
export type LabAnalyte = Static<typeof LabAnalyte>;

export const LabResult = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    sampleId: Type.String(),
    orderId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    labTestId: Type.String(),
    testCode: Type.String(),
    testName: Type.String(),
    resultType: ResultType,
    value: Type.String({
      description: 'The number as entered, its decimals kept (`5.10`), or the text.',
    }),
    unit: Type.Optional(Type.String()),
    range: Type.Optional(ref(LabRange)),
    flag: Type.Optional(ref(LabResultFlag)),
    comment: Type.Optional(Type.String()),
    status: ref(LabResultStatus),
    enteredAt: Type.String({ format: 'date-time' }),
    enteredByName: Type.String(),
    verifiedAt: Type.Optional(Type.String({ format: 'date-time' })),
    verifiedByName: Type.Optional(Type.String()),
    amendsId: Type.Optional(Type.String()),
    amendmentReason: Type.Optional(Type.String()),
    amendedById: Type.Optional(
      Type.String({ description: 'The correction that replaced it: this one is history.' }),
    ),
    collectedAt: Type.String({
      format: 'date-time',
      description: 'When its sample was collected: the time a trend is drawn at (#92).',
    }),
    acknowledgedAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'When a doctor acknowledged this critical result (#92).',
      }),
    ),
    acknowledgedByName: Type.Optional(Type.String()),
    version: Type.Integer(),
  },
  {
    $id: 'LabResult',
    description:
      'One result of one test of a sample. Never changed, apart from being verified once: a correction is a new result naming this one.',
  },
);
export type LabResult = Static<typeof LabResult>;

export const LabOrderResults = Type.Object(
  {
    orderId: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    itemName: Type.String({ description: 'The test as ordered.' }),
    priority: ref(OrderPriority),
    orderStatus: ref(OrderStatus),
    sample: Type.Optional(ref(LabSample)),
    analytes: Type.Array(ref(LabAnalyte)),
    results: Type.Array(ref(LabResult), {
      description:
        'Every result of the sample, corrections included, oldest first. The current one of a test is the one with no `amendedById`. A caller who may neither enter nor verify results gets no result that is not verified: see `awaitingVerification`.',
    }),
    awaitingVerification: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Given only to a caller who may neither enter nor verify results (a doctor): the tests (`labTestId`) whose current result is entered and not yet verified, left out of `results` so it is never read as final. A test being corrected keeps its replaced result in `results`, which names a correction that is not there.',
      }),
    ),
  },
  {
    $id: 'LabOrderResults',
    description:
      'The results of a lab order: those of its sample that is not rejected, and what they are entered for. No sample yet: no results.',
  },
);
export type LabOrderResults = Static<typeof LabOrderResults>;

const Value = Type.String({
  minLength: 1,
  maxLength: VALUE_MAX,
  pattern: PLAIN_LINES,
  description:
    'For a numeric test a decimal number (`5.1`, `-0.25`, up to six decimals and smaller than a thousand million either side of zero; 422 `invalid_number` otherwise); for a text test the text.',
});
const Comment = Type.Optional(
  Type.String({ minLength: 1, maxLength: COMMENT_MAX, pattern: PLAIN_LINES }),
);

export const LabResultEntry = Type.Object(
  { labTestId: Id, value: Value, comment: Comment },
  { $id: 'LabResultEntry', additionalProperties: false },
);
export type LabResultEntry = Static<typeof LabResultEntry>;

export const LabResultsEnter = Type.Object(
  {
    results: Type.Array(ref(LabResultEntry), {
      minItems: 1,
      maxItems: RESULTS_MAX,
      description: 'Some or all of the tests of the order, each once.',
    }),
  },
  { $id: 'LabResultsEnter', additionalProperties: false },
);
export type LabResultsEnter = Static<typeof LabResultsEnter>;

export const LabResultsVerify = Type.Object(
  {
    resultIds: Type.Array(Id, {
      minItems: 1,
      maxItems: RESULTS_MAX,
      description:
        'The results as the verifier read them: each current and entered, or 409 `conflict`.',
    }),
  },
  { $id: 'LabResultsVerify', additionalProperties: false },
);
export type LabResultsVerify = Static<typeof LabResultsVerify>;

export const LabResultAmend = Type.Object(
  {
    value: Value,
    comment: Comment,
    reason: Type.String({ minLength: 1, maxLength: REASON_MAX, pattern: PLAIN_TEXT }),
  },
  { $id: 'LabResultAmend', additionalProperties: false },
);
export type LabResultAmend = Static<typeof LabResultAmend>;

export const LabResultSearch = Type.Object(
  {
    patientId: Id,
    labTestId: Type.Optional(Id),
    encounterId: Type.Optional(Id),
    cursor: Type.Optional(
      Type.String({
        maxLength: 1024,
        description: 'Opaque. Pass the nextCursor of the previous page.',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: 'Absent: 25.' }),
    ),
  },
  { $id: 'LabResultSearch', additionalProperties: false },
);
export type LabResultSearch = Static<typeof LabResultSearch>;

export const LabResultPage = CursorPage(ref(LabResult), { $id: 'LabResultPage' });

export const LAB_SCHEMAS = [
  OrderPriority,
  OrderStatus,
  LabStage,
  LabSampleStatus,
  LabRejectReason,
  LabResultFlag,
  LabResultStatus,
  LabSample,
  LabWorkItem,
  LabWorkItemPage,
  LabSampleReceive,
  LabSampleReject,
  LabRange,
  LabAnalyte,
  LabResult,
  LabOrderResults,
  LabResultEntry,
  LabResultsEnter,
  LabResultsVerify,
  LabResultAmend,
  LabResultSearch,
  LabResultPage,
];
