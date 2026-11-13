import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { MEDICATION_ROUTES } from '../clinical/index.js';
import { VITAL_LIMITS, VITAL_MEASURES } from '../triage/index.js';

export const REASON_MAX = 200;
export const NOTE_BODY_MAX = 4000;
export const DOSE_GIVEN_MAX = 50;

const named = <const Values extends readonly string[]>(
  $id: string,
  values: Values,
  description: string,
) => Type.Unsafe<Values[number]>({ $id, type: 'string', enum: [...values], description });

const Id = Type.String({ maxLength: 64 });
const Instant = Type.String({ format: 'date-time' });
const Reason = Type.String({ minLength: 1, maxLength: REASON_MAX, pattern: PLAIN_TEXT });

export const AdmissionParams = Type.Object({ admissionId: Id });
export const VitalParams = Type.Object({ admissionId: Id, vitalId: Id });
export const EntryParams = Type.Object({ entryId: Id });
export const NoteParams = Type.Object({ noteId: Id });

export const PageQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
});
export const MarQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
  orderId: Type.Optional(Id),
});

// --- vital signs -------------------------------------------------------------------------------

const measures = () =>
  Object.fromEntries(
    VITAL_MEASURES.map((name) => {
      const { minimum, maximum, whole, description } = VITAL_LIMITS[name];
      const schema = whole
        ? Type.Integer({ minimum, maximum, description })
        : Type.Number({ minimum, maximum, description });
      return [name, Type.Optional(schema)];
    }),
  );

export const WardVitalFlags = Type.Object(
  Object.fromEntries(
    ['systolic', 'diastolic', 'pulse', 'temperature', 'spo2'].map((name) => [
      name,
      Type.Optional(Type.Unsafe<'low' | 'high'>({ type: 'string', enum: ['low', 'high'] })),
    ]),
  ),
  {
    $id: 'WardVitalFlags',
    additionalProperties: false,
    description:
      'Which values were outside the normal ranges in effect when the reading was taken, for the patient age band that day.',
  },
);

export const WardVital = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    admissionId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    observedAt: Instant,
    recordedAt: Instant,
    recordedById: Type.String(),
    recordedByName: Type.String(),
    ...measures(),
    flags: Type.Optional(ref(WardVitalFlags)),
    correctsId: Type.Optional(Type.String()),
    correctionReason: Type.Optional(Type.String()),
    correctedById: Type.Optional(
      Type.String({ description: 'The reading that corrects this one. Absent while it stands.' }),
    ),
  },
  {
    $id: 'WardVital',
    additionalProperties: false,
    description:
      'One set of vital signs taken on the ward, append-only: a correction is a new reading that names the one it corrects, once. Kept apart from the readings triage takes at the queue.',
  },
);
export const WardVitalPage = CursorPage(ref(WardVital), { $id: 'WardVitalPage' });

export const WardVitalCreate = Type.Object(
  {
    observedAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'When it was taken: now when not sent, never in the future.',
      }),
    ),
    ...measures(),
  },
  {
    $id: 'WardVitalCreate',
    additionalProperties: false,
    description:
      'At least one measurement. Systolic and diastolic go together, the diastolic below the systolic.',
  },
);
export type WardVitalCreate = Static<typeof WardVitalCreate>;

export const WardVitalCorrect = Type.Object(
  {
    reason: Reason,
    ...measures(),
  },
  {
    $id: 'WardVitalCorrect',
    additionalProperties: false,
    description:
      'The corrected measurements (the whole reading, as it should have read) and why. The time it was taken is the corrected reading one.',
  },
);
export type WardVitalCorrect = Static<typeof WardVitalCorrect>;

// --- the medication chart ----------------------------------------------------------------------

export const MAR_OUTCOMES = ['given', 'withheld', 'refused', 'missed'] as const;
export type MarOutcomeValue = (typeof MAR_OUTCOMES)[number];
export const MarOutcome = named(
  'MarOutcome',
  MAR_OUTCOMES,
  'What happened at a scheduled dose. Anything but given needs a reason.',
);
const RouteName = Type.Unsafe<string>({ type: 'string', enum: [...MEDICATION_ROUTES] });

export const MarOrder = Type.Object(
  {
    id: Type.String(),
    drugId: Type.String(),
    itemName: Type.String(),
    dose: Type.String(),
    route: Type.String(),
    frequency: Type.String(),
    status: Type.String({ description: 'The order status: only a cancelled one takes no entry.' }),
    placedAt: Instant,
    dispensed: Type.Boolean({ description: 'Whether the pharmacy has dispensed against it.' }),
  },
  {
    $id: 'MarOrder',
    additionalProperties: false,
    description: 'A medication order of the stay, as the ward chart shows it.',
  },
);
export const MarOrderPage = CursorPage(ref(MarOrder), { $id: 'MarOrderPage' });

export const MarEntry = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    admissionId: Type.String(),
    orderId: Type.String(),
    drugId: Type.String(),
    scheduledAt: Instant,
    outcome: ref(MarOutcome),
    doseGiven: Type.Optional(Type.String()),
    route: Type.Optional(Type.String()),
    reason: Type.Optional(Type.String()),
    administeredAt: Type.Optional(Instant),
    recordedAt: Instant,
    recordedById: Type.String(),
    recordedByName: Type.String(),
    witnessId: Type.Optional(Type.String()),
    correctsId: Type.Optional(Type.String()),
    correctedById: Type.Optional(Type.String()),
    warnings: Type.Optional(
      Type.Array(Type.Unsafe<'not_dispensed'>({ type: 'string', enum: ['not_dispensed'] }), {
        description:
          '`not_dispensed`: the pharmacy has dispensed nothing against the order. A warning only; the entry was recorded. Not repeated on a replay.',
      }),
    ),
  },
  {
    $id: 'MarEntry',
    additionalProperties: false,
    description:
      'One entry on the medication chart, append-only: a correction is a new entry for the same order and time that names the one it corrects, once.',
  },
);
export const MarEntryPage = CursorPage(ref(MarEntry), { $id: 'MarEntryPage' });

const WitnessId = Type.String({
  maxLength: 64,
  description: 'A second member of staff who saw it given. Optional; no rule requires one yet.',
});

export const MarEntryCreate = Type.Object(
  {
    admissionId: Id,
    orderId: Id,
    scheduledAt: Type.String({ format: 'date-time', description: 'The time the dose was due.' }),
    outcome: ref(MarOutcome),
    doseGiven: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: DOSE_GIVEN_MAX,
        pattern: PLAIN_TEXT,
        description: 'Only when given; the order dose when not sent.',
      }),
    ),
    route: Type.Optional(RouteName),
    administeredAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'Only when given: now when not sent, never in the future.',
      }),
    ),
    reason: Type.Optional(Reason),
    witnessId: Type.Optional(WitnessId),
  },
  {
    $id: 'MarEntryCreate',
    additionalProperties: false,
    description:
      'Reason is required unless the dose was given, and for a given dose beyond the order frequency in a day.',
  },
);
export type MarEntryCreate = Static<typeof MarEntryCreate>;

export const MarEntryCorrect = Type.Object(
  {
    outcome: ref(MarOutcome),
    doseGiven: Type.Optional(
      Type.String({ minLength: 1, maxLength: DOSE_GIVEN_MAX, pattern: PLAIN_TEXT }),
    ),
    route: Type.Optional(RouteName),
    administeredAt: Type.Optional(Type.String({ format: 'date-time' })),
    reason: Reason,
    witnessId: Type.Optional(WitnessId),
  },
  {
    $id: 'MarEntryCorrect',
    additionalProperties: false,
    description:
      'The entry as it should have read, and why it is corrected. The order and the time due are the corrected entry one.',
  },
);
export type MarEntryCorrect = Static<typeof MarEntryCorrect>;

// --- progress notes ----------------------------------------------------------------------------

export const NOTE_KINDS = ['nursing', 'handover', 'observation'] as const;
export const ProgressNoteKind = named('ProgressNoteKind', NOTE_KINDS, 'What a progress note is.');

export const ProgressNote = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    admissionId: Type.String(),
    kind: ref(ProgressNoteKind),
    body: Type.String(),
    createdAt: Instant,
    createdById: Type.String(),
    createdByName: Type.String(),
    updatedAt: Instant,
    updatedById: Type.String(),
    version: Type.Integer({ minimum: 1 }),
  },
  {
    $id: 'ProgressNote',
    additionalProperties: false,
    description:
      'A nursing note, editable by its author while the patient is admitted; every text it had is kept in its history.',
  },
);
export const ProgressNotePage = CursorPage(ref(ProgressNote), { $id: 'ProgressNotePage' });

const NoteBody = Type.String({ minLength: 1, maxLength: NOTE_BODY_MAX, pattern: PLAIN_TEXT });
export const ProgressNoteCreate = Type.Object(
  { kind: ref(ProgressNoteKind), body: NoteBody },
  { $id: 'ProgressNoteCreate', additionalProperties: false },
);
export type ProgressNoteCreate = Static<typeof ProgressNoteCreate>;
export const ProgressNoteUpdate = Type.Object(
  { body: NoteBody, version: Type.Integer({ minimum: 1 }) },
  {
    $id: 'ProgressNoteUpdate',
    additionalProperties: false,
    description: 'The new text and the version the edit started from (409 `conflict` if stale).',
  },
);
export type ProgressNoteUpdate = Static<typeof ProgressNoteUpdate>;

export const ProgressNoteVersion = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    body: Type.String(),
    editedAt: Instant,
    editedById: Type.String(),
    editedByName: Type.String(),
  },
  { $id: 'ProgressNoteVersion', additionalProperties: false },
);
export const ProgressNoteVersionPage = CursorPage(ref(ProgressNoteVersion), {
  $id: 'ProgressNoteVersionPage',
});

// --- diet and ward stock -----------------------------------------------------------------------

export const WardDietOrder = Type.Object(
  {
    id: Type.String(),
    status: Type.String(),
    priority: Type.String(),
    instructions: Type.String(),
    placedAt: Instant,
  },
  { $id: 'WardDietOrder', additionalProperties: false },
);
export const WardDiet = Type.Object(
  { items: Type.Array(ref(WardDietOrder)) },
  {
    $id: 'WardDiet',
    additionalProperties: false,
    description: 'The diet orders of the stay that are not cancelled, newest first (at most 50).',
  },
);

export const KitchenListItem = Type.Object(
  {
    admissionId: Id,
    patientId: Id,
    patientName: Type.String(),
    patientMrn: Type.String(),
    wardId: Type.Optional(Id),
    wardName: Type.Optional(Type.String()),
    roomName: Type.Optional(Type.String()),
    bedNumber: Type.Optional(Type.String()),
    admittedAt: Instant,
    diet: Type.Union([ref(WardDietOrder), Type.Null()], {
      description: 'The newest diet order not cancelled or finished, or null when there is none.',
    }),
  },
  { $id: 'KitchenListItem', additionalProperties: false },
);
export const KitchenListPage = CursorPage(ref(KitchenListItem), { $id: 'KitchenListPage' });
export const KitchenListQuery = Type.Object({
  wardId: Type.Optional(Id),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE })),
});

export const WardStockRequestCreate = Type.Object(
  {
    fromLocationId: Id,
    toLocationId: Id,
    note: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT })),
    lines: Type.Array(
      Type.Object(
        {
          drugId: Id,
          quantity: Type.Integer({ minimum: 1, maximum: 1_000_000 }),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 50 },
    ),
  },
  {
    $id: 'WardStockRequestCreate',
    additionalProperties: false,
    description:
      'The ward place (fromLocationId), the store asked (toLocationId) and the items, as an indent.',
  },
);
export type WardStockRequestCreate = Static<typeof WardStockRequestCreate>;

export const WardStockRequest = Type.Object(
  {
    id: Type.String(),
    admissionId: Type.String(),
    indentId: Type.String(),
    placeId: Type.String(),
    requestedAt: Instant,
    requestedById: Type.String(),
  },
  { $id: 'WardStockRequest', additionalProperties: false },
);

export const NURSING_SCHEMAS = [
  WardVitalFlags,
  WardVital,
  WardVitalPage,
  WardVitalCreate,
  WardVitalCorrect,
  MarOutcome,
  MarOrder,
  MarOrderPage,
  MarEntry,
  MarEntryPage,
  MarEntryCreate,
  MarEntryCorrect,
  ProgressNoteKind,
  ProgressNote,
  ProgressNotePage,
  ProgressNoteCreate,
  ProgressNoteUpdate,
  ProgressNoteVersion,
  ProgressNoteVersionPage,
  WardDietOrder,
  WardDiet,
  KitchenListItem,
  KitchenListPage,
  WardStockRequestCreate,
  WardStockRequest,
];
