import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

/** What a body can be, as the API takes it: not what is normal, which the ranges say. */
export const LIMITS = {
  systolic: { minimum: 40, maximum: 300, whole: true, description: 'mmHg.' },
  diastolic: { minimum: 20, maximum: 200, whole: true, description: 'mmHg.' },
  pulse: { minimum: 20, maximum: 300, whole: true, description: 'Beats a minute.' },
  temperature: {
    minimum: 25,
    maximum: 45,
    whole: false,
    description: 'Degrees Celsius, at most one decimal.',
  },
  spo2: { minimum: 50, maximum: 100, whole: true, description: 'Oxygen saturation, %.' },
  weight: { minimum: 0.3, maximum: 400, whole: false, description: 'kg, at most one decimal.' },
  height: { minimum: 20, maximum: 250, whole: false, description: 'cm, at most one decimal.' },
} as const;
export type Measure = keyof typeof LIMITS;
export const MEASURES = Object.keys(LIMITS) as Measure[];

export const COMPLAINT_MAX = 500;
export const CORRECTION_REASON_MAX = 200;
export const SUBSTANCE_MAX = 100;
export const REACTION_MAX = 200;
export const ALLERGIES_MAX = 50;

const measures = () =>
  Object.fromEntries(
    MEASURES.map((name) => {
      const { minimum, maximum, whole, description } = LIMITS[name];
      const schema = whole
        ? Type.Integer({ minimum, maximum, description })
        : Type.Number({ minimum, maximum, description });
      return [name, Type.Optional(schema)];
    }),
  );

const ChiefComplaint = Type.String({
  minLength: 1,
  maxLength: COMPLAINT_MAX,
  pattern: PLAIN_LINES,
  description: 'Plain text of one or more lines: what brings the patient today, in their words.',
});
const CorrectsId = Type.String({
  maxLength: 64,
  description: 'The reading of the same patient this one corrects. The original is kept.',
});
const CorrectionReason = Type.String({
  minLength: 1,
  maxLength: CORRECTION_REASON_MAX,
  pattern: PLAIN_TEXT,
  description: 'Plain text. Required with correctsId, refused without it.',
});

export const Vitals = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    patientId: Type.String(),
    queueTokenId: Type.Optional(
      Type.String({
        description:
          'The token the reading was taken for. A correction carries the one of the reading it corrects.',
      }),
    ),
    encounterId: Type.Optional(
      Type.String({
        description:
          'Set once, from empty to the encounter, by the triage module itself when it hears encounter.opened for the reading’s queue token (idempotently); nothing else of a reading ever changes. A reading taken outside the queue gets none until the API attaches readings to the patient’s open encounter (M7).',
      }),
    ),
    recordedAt: Type.String({ format: 'date-time' }),
    recordedById: Type.String(),
    recordedByName: Type.String(),
    ...measures(),
    chiefComplaint: Type.Optional(ChiefComplaint),
    correctsId: Type.Optional(CorrectsId),
    correctionReason: Type.Optional(CorrectionReason),
  },
  {
    $id: 'Vitals',
    additionalProperties: false,
    description:
      'One reading of vital signs, append-only: a correction is a new reading that names the one it corrects. Attached to the patient and, when taken at the queue, to the token; encounterId is set once the OPD encounter exists (M7).',
  },
);

export const VitalsCreate = Type.Object(
  {
    queueTokenId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'Today’s token of this patient the reading was taken for. Not sent with a correction, which takes the corrected reading’s.',
      }),
    ),
    ...measures(),
    chiefComplaint: Type.Optional(ChiefComplaint),
    correctsId: Type.Optional(CorrectsId),
    correctionReason: Type.Optional(CorrectionReason),
  },
  {
    $id: 'VitalsCreate',
    additionalProperties: false,
    description:
      'At least one measurement or a chief complaint. Systolic and diastolic go together, the diastolic below the systolic.',
  },
);
export type VitalsCreate = Static<typeof VitalsCreate>;

export const VitalsPage = CursorPage(ref(Vitals), { $id: 'VitalsPage' });

export const VitalRange = Type.Object(
  { low: Type.Optional(Type.Number()), high: Type.Optional(Type.Number()) },
  {
    $id: 'VitalRange',
    additionalProperties: false,
    description:
      'Values below low or above high are abnormal. A limit that is absent is not checked.',
  },
);

export const RANGED = ['systolic', 'diastolic', 'pulse', 'temperature', 'spo2'] as const;
export type Ranged = (typeof RANGED)[number];

export const VitalRanges = Type.Object(
  {
    ranges: Type.Union(
      [
        Type.Object(
          Object.fromEntries(RANGED.map((name) => [name, Type.Optional(ref(VitalRange))])),
          { additionalProperties: false },
        ),
        Type.Null(),
      ],
      {
        description:
          'The hospital’s ranges that apply to this patient, or null when none do (a patient under 18: ranges are for adults until #379).',
      },
    ),
  },
  { $id: 'VitalRanges', additionalProperties: false },
);

export const SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'] as const;
export const AllergySeverity = Type.Unsafe<(typeof SEVERITIES)[number]>({
  $id: 'AllergySeverity',
  type: 'string',
  enum: [...SEVERITIES],
});

export const Allergy = Type.Object(
  {
    substance: Type.String({
      minLength: 1,
      maxLength: SUBSTANCE_MAX,
      pattern: PLAIN_TEXT,
      description: 'Plain text.',
    }),
    reaction: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: REACTION_MAX,
        pattern: PLAIN_TEXT,
        description: 'Plain text.',
      }),
    ),
    severity: ref(AllergySeverity),
  },
  { $id: 'Allergy', additionalProperties: false },
);
export type Allergy = Static<typeof Allergy>;

export const ALLERGY_STATUSES = ['unknown', 'none', 'listed'] as const;
export type AllergyStatusValue = (typeof ALLERGY_STATUSES)[number];
export const AllergyStatus = Type.Unsafe<AllergyStatusValue>({
  $id: 'AllergyStatus',
  type: 'string',
  enum: [...ALLERGY_STATUSES],
  description:
    '`unknown`: never asked. `none`: asked, no known allergies. `listed`: the items. Never asked and none are not the same.',
});

export const AllergyList = Type.Object(
  {
    patientId: Type.String(),
    tenantId: Type.String(),
    status: ref(AllergyStatus),
    items: Type.Array(ref(Allergy)),
    version: Type.Integer({ minimum: 0, description: '0 while never recorded.' }),
    updatedAt: Type.Optional(Type.String({ format: 'date-time' })),
    updatedByName: Type.Optional(Type.String()),
  },
  { $id: 'AllergyList', additionalProperties: false },
);

export const AllergyListUpdate = Type.Object(
  {
    version: Type.Integer({
      minimum: 0,
      description:
        'The version the edit started from (0 while never recorded). Another one gives 409 `conflict`.',
    }),
    status: Type.Unsafe<'none' | 'listed'>({ type: 'string', enum: ['none', 'listed'] }),
    items: Type.Array(ref(Allergy), { maxItems: ALLERGIES_MAX }),
  },
  {
    $id: 'AllergyListUpdate',
    additionalProperties: false,
    description: '`none` with no items, `listed` with 1 to 50.',
  },
);
export type AllergyListUpdate = Static<typeof AllergyListUpdate>;

const Id = Type.String({ maxLength: 64 });

export const PatientParams = Type.Object({ patientId: Id });
export const VitalsParams = Type.Object({ patientId: Id, vitalsId: Id });

export const VitalsListQuery = Type.Object({
  queueTokenId: Type.Optional(Type.String({ maxLength: 64 })),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const TRIAGE_SCHEMAS = [
  Vitals,
  VitalsCreate,
  VitalsPage,
  VitalRange,
  VitalRanges,
  AllergySeverity,
  Allergy,
  AllergyStatus,
  AllergyList,
  AllergyListUpdate,
] as const;
