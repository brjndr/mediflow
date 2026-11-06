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

/** The measurements a hospital's ranges can mark abnormal. */
export const RANGED = ['systolic', 'diastolic', 'pulse', 'temperature', 'spo2'] as const;
export type Ranged = (typeof RANGED)[number];

/** Age bands the ranges are kept for, youngest first (#379). */
export const BANDS = ['infant', 'child', 'adolescent', 'adult'] as const;

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

export const VitalFlags = Type.Object(
  Object.fromEntries(
    RANGED.map((name) => [
      name,
      Type.Optional(Type.Unsafe<'low' | 'high'>({ type: 'string', enum: ['low', 'high'] })),
    ]),
  ),
  {
    $id: 'VitalFlags',
    additionalProperties: false,
    description:
      'Which values were outside the normal ranges in effect when the reading was recorded, for the patient’s age band that day. A value that is not listed was within them, or had no range.',
  },
);

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
    flags: Type.Optional(ref(VitalFlags)),
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
  {
    low: Type.Optional(Type.Number({ minimum: 0, maximum: 999.9 })),
    high: Type.Optional(Type.Number({ minimum: 0, maximum: 999.9 })),
  },
  {
    $id: 'VitalRange',
    additionalProperties: false,
    description:
      'Values below low or above high are abnormal. A limit that is absent is not checked.',
  },
);

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
          'The hospital’s ranges for the patient’s age band today, at the hospital’s date. Null is kept for a patient with no known band; today every patient has one.',
      },
    ),
  },
  { $id: 'VitalRanges', additionalProperties: false },
);

export const VitalRangeSet = Type.Object(
  Object.fromEntries(RANGED.map((name) => [name, Type.Optional(ref(VitalRange))])),
  {
    $id: 'VitalRangeSet',
    additionalProperties: false,
    description:
      'The ranges of one age band. A measure that is absent, or has neither limit, is not checked.',
  },
);

export const VitalRangeTable = Type.Object(
  {
    version: Type.Integer({
      minimum: 0,
      description:
        'How many times the ranges were saved: 0 while the hospital uses the built-in ones. Sent back with a save, which is refused with 409 conflict if another save came first.',
    }),
    bands: Type.Object(Object.fromEntries(BANDS.map((band) => [band, ref(VitalRangeSet)])), {
      additionalProperties: false,
      description:
        'Infant (under 1 year), child (1 to 11), adolescent (12 to 17) and adult (18 and over), by the patient’s age at the hospital’s date on the day of the reading.',
    }),
  },
  {
    $id: 'VitalRangeTable',
    additionalProperties: false,
    description: 'A hospital’s normal ranges for every age band, as they apply now.',
  },
);
export type VitalRangeTableBody = Static<typeof VitalRangeTable>;

export const SEVERITIES = ['mild', 'moderate', 'severe', 'unknown'] as const;
export const AllergySeverity = Type.Unsafe<(typeof SEVERITIES)[number]>({
  $id: 'AllergySeverity',
  type: 'string',
  enum: [...SEVERITIES],
});

export const ALLERGEN_KINDS = ['drug', 'drug_class', 'food', 'other'] as const;
export type AllergenKindValue = (typeof ALLERGEN_KINDS)[number];
export const AllergenKind = Type.Unsafe<AllergenKindValue>({
  $id: 'AllergenKind',
  type: 'string',
  enum: [...ALLERGEN_KINDS],
  description:
    '`drug`: a medicine’s generic name. `drug_class`: a class of medicines. `food` and `other`: match no medicine.',
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
    // Present when the allergy names a catalog entry (#380); absent for free text.
    kind: Type.Optional(ref(AllergenKind)),
    allergenId: Type.Optional(
      Type.String({ description: 'The allergen catalog entry (a class, food or other).' }),
    ),
    drugId: Type.Optional(
      Type.String({
        description:
          'A medicine of the hospital’s drug catalog the generic name was taken from (kind `drug`).',
      }),
    ),
    members: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Lower-case generic names the allergy covers, as the catalog had them when it was saved (a class’s members, or the one generic name of a drug). A medicine is covered when a word of its generic name begins with one. Empty or absent for free text, a food and others.',
      }),
    ),
  },
  { $id: 'Allergy', additionalProperties: false },
);
export type Allergy = Static<typeof Allergy>;

/** What a request names an allergy by: the server fills the rest from the catalog. */
export const AllergyInput = Type.Object(
  {
    substance: Type.String({
      minLength: 1,
      maxLength: SUBSTANCE_MAX,
      pattern: PLAIN_TEXT,
      description:
        'Plain text. With `allergenId` or `drugId` the catalog’s name is stored instead, and this is only the fallback.',
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
    allergenId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'An entry of the allergen catalog (422 `unknown_allergen` if there is none). Not with `drugId`.',
      }),
    ),
    drugId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'A medicine of the hospital in use (422 `unknown_allergen` if there is none): the allergy is to its generic name. Not with `allergenId`.',
      }),
    ),
  },
  { $id: 'AllergyInput', additionalProperties: false },
);
export type AllergyInput = Static<typeof AllergyInput>;

export const Allergen = Type.Object(
  {
    name: Type.String(),
    kind: ref(AllergenKind),
    allergenId: Type.Optional(Type.String()),
    drugId: Type.Optional(Type.String()),
  },
  {
    $id: 'Allergen',
    additionalProperties: false,
    description:
      'Something an allergy can name: a catalog entry (`allergenId`) or the generic name of a medicine of the hospital (`drugId`, one of the medicines that carry it).',
  },
);

export const AllergenPage = CursorPage(ref(Allergen), { $id: 'AllergenPage' });

export const AllergenSearchRequest = Type.Object(
  {
    q: Type.Optional(Type.String({ maxLength: 100 })),
    kind: Type.Optional(ref(AllergenKind)),
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
  { $id: 'AllergenSearchRequest', additionalProperties: false },
);
export type AllergenSearchRequest = Static<typeof AllergenSearchRequest>;

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
    items: Type.Array(ref(AllergyInput), { maxItems: ALLERGIES_MAX }),
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
  VitalRangeSet,
  VitalRangeTable,
  VitalFlags,
  AllergySeverity,
  AllergenKind,
  Allergy,
  AllergyInput,
  Allergen,
  AllergenPage,
  AllergenSearchRequest,
  AllergyStatus,
  AllergyList,
  AllergyListUpdate,
] as const;
