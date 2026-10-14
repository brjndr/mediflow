import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref, StringEnum } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { AGE_UNITS } from './age.js';

export const CODE_MAX = 30;
export const NAME_MAX = 150;
export const UNIT_MAX = 30;
export const CONTAINER_MAX = 50;
export const NOTE_MAX = 150;
/** The most components a panel has, and the most reference ranges a test has. */
export const LIST_MAX = 60;
/**
 * The largest a limit can be, either side of zero: what the catalog screen can show without an
 * exponent, and far beyond any laboratory value.
 */
export const LIMIT_MAX = 999_999_999;
/** The oldest age a limit can name, in days: 150 years. Each unit has its own (age.ts). */
export const AGE_VALUE_MAX = 54750;

export const LAB_DEPARTMENTS = [
  'biochemistry',
  'haematology',
  'microbiology',
  'serology',
  'hormones',
  'pathology',
  'other',
] as const;
export type LabDepartment = (typeof LAB_DEPARTMENTS)[number];

export const LAB_KINDS = ['test', 'panel'] as const;
export type LabKind = (typeof LAB_KINDS)[number];

export const RESULT_TYPES = ['numeric', 'text'] as const;
export type ResultType = (typeof RESULT_TYPES)[number];

export const SAMPLE_TYPES = [
  'blood',
  'serum',
  'plasma',
  'urine',
  'stool',
  'swab',
  'sputum',
  'csf',
  'tissue',
  'other',
] as const;
export type SampleType = (typeof SAMPLE_TYPES)[number];

export const RANGE_SEXES = ['any', 'male', 'female'] as const;
export type RangeSex = (typeof RANGE_SEXES)[number];

/** The sexes a patient is recorded with. A patient recorded as other gets only a range for any. */
export const PATIENT_SEXES = ['male', 'female', 'other'] as const;

const Department = StringEnum(LAB_DEPARTMENTS, { description: 'The section of the laboratory.' });
const Kind = StringEnum(LAB_KINDS, {
  description:
    'A single test, or a panel: a named set of tests ordered together (a lipid profile). A panel has components and no result of its own.',
});
const ResultTypeSchema = StringEnum(RESULT_TYPES, {
  description:
    'How a result is recorded: a number against a reference range, or text (positive, negative, a description). For a panel it means nothing.',
});
const Sample = StringEnum(SAMPLE_TYPES);
const Name = Type.String({ minLength: 1, maxLength: NAME_MAX, pattern: PLAIN_TEXT });
const Unit = Type.String({
  maxLength: UNIT_MAX,
  pattern: PLAIN_TEXT,
  description: 'The unit of a numeric result: g/dL.',
});
const Container = Type.String({
  maxLength: CONTAINER_MAX,
  pattern: PLAIN_TEXT,
  description: 'What the sample is collected in.',
});
const Turnaround = Type.Integer({
  minimum: 1,
  maximum: 720,
  description: 'How long a result usually takes from collection.',
});
const ServiceId = Type.String({
  maxLength: 64,
  description:
    "The service the test is charged as: a laboratory service of the same hospital's catalog. Empty text removes the link on a change.",
});
const ComponentIds = Type.Array(Type.String({ maxLength: 64 }), {
  maxItems: LIST_MAX,
  description: 'The single tests of a panel, in the order they are reported.',
});

export const LabTestComponent = Type.Object(
  { id: Type.String(), code: Type.String(), name: Type.String() },
  { $id: 'LabTestComponent' },
);
export type LabTestComponent = Static<typeof LabTestComponent>;

export const LabTest = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    code: Type.String({
      description: "The test's identity on orders and reports. Never changes.",
    }),
    name: Type.String({ minLength: 1, maxLength: NAME_MAX }),
    department: Department,
    kind: Kind,
    resultType: ResultTypeSchema,
    unit: Type.Optional(Unit),
    sampleType: Sample,
    container: Type.Optional(Container),
    turnaroundHours: Turnaround,
    serviceId: Type.Optional(Type.String()),
    serviceName: Type.Optional(
      Type.String({
        description:
          'The name of the linked service, when there is one. The name alone is shown to everyone who may read the test, by decision; nothing else of the service (a price, a tax class) is ever added here.',
      }),
    ),
    components: Type.Array(ref(LabTestComponent), {
      description: 'The tests of a panel. Empty for a single test.',
    }),
    archived: Type.Boolean(),
    version: Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' }),
  },
  {
    $id: 'LabTest',
    description:
      'A test or a panel the laboratory offers: what it is, how it is collected and how its result is read. Holds no patient data.',
  },
);
export type LabTest = Static<typeof LabTest>;

export const LabTestPage = CursorPage(ref(LabTest), { $id: 'LabTestPage' });

export const LabTestCreate = Type.Object(
  {
    code: Type.String({
      minLength: 1,
      maxLength: CODE_MAX,
      pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$',
    }),
    name: Name,
    department: Department,
    kind: Kind,
    resultType: Type.Optional(ResultTypeSchema),
    unit: Type.Optional(Unit),
    sampleType: Sample,
    container: Type.Optional(Container),
    turnaroundHours: Turnaround,
    serviceId: Type.Optional(ServiceId),
    componentIds: Type.Optional(ComponentIds),
  },
  { $id: 'LabTestCreate', additionalProperties: false },
);
export type LabTestCreate = Static<typeof LabTestCreate>;

export const LabTestUpdate = Type.Object(
  {
    name: Type.Optional(Name),
    department: Type.Optional(Department),
    resultType: Type.Optional(ResultTypeSchema),
    unit: Type.Optional(Unit),
    sampleType: Type.Optional(Sample),
    container: Type.Optional(Container),
    turnaroundHours: Type.Optional(Turnaround),
    serviceId: Type.Optional(ServiceId),
    componentIds: Type.Optional(ComponentIds),
    expectedVersion: Type.Integer(),
  },
  { $id: 'LabTestUpdate', additionalProperties: false },
);
export type LabTestUpdate = Static<typeof LabTestUpdate>;

/**
 * In the body, never the query string: see Searches in the root CLAUDE.md. No default value on
 * the fields of a body: the generated client would make them required.
 */
export const LabTestSearchRequest = Type.Object(
  {
    cursor: Type.Optional(
      Type.String({
        maxLength: 1024,
        description: 'Opaque. Pass the nextCursor of the previous page.',
      }),
    ),
    limit: Type.Optional(
      Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: 'Absent: 25.' }),
    ),
    q: Type.Optional(Type.String({ maxLength: 100 })),
    department: Type.Optional(StringEnum(LAB_DEPARTMENTS)),
    kind: Type.Optional(StringEnum(LAB_KINDS)),
    archived: Type.Optional(
      Type.Boolean({
        description: 'True lists the archived tests instead of the active ones. Absent: false.',
      }),
    ),
  },
  { $id: 'LabTestSearchRequest', additionalProperties: false },
);
export type LabTestSearchRequest = Static<typeof LabTestSearchRequest>;

export const LabAge = Type.Object(
  {
    value: Type.Integer({ minimum: 0, maximum: AGE_VALUE_MAX }),
    unit: StringEnum(AGE_UNITS),
  },
  {
    $id: 'LabAge',
    additionalProperties: false,
    description:
      'An age as it is written: a value with its unit. Never turned into a count of days: a patient reaches it on the calendar day that lies that long after the date of birth, so leap years and the lengths of months are respected. At most 150 years, in any unit.',
  },
);
export type LabAge = Static<typeof LabAge>;

const LIMIT = { minimum: -LIMIT_MAX, maximum: LIMIT_MAX };

export const LabRange = Type.Object(
  {
    sex: StringEnum(RANGE_SEXES, {
      description: 'Whom the row is for. A row for one sex is used before a row for any.',
    }),
    ageFrom: ref(LabAge),
    ageUntil: Type.Optional(ref(LabAge)),
    low: Type.Optional(
      Type.Number({
        ...LIMIT,
        description: 'The lowest normal value. Absent: no lower limit.',
      }),
    ),
    high: Type.Optional(
      Type.Number({
        ...LIMIT,
        description: 'The highest normal value. Absent: no upper limit.',
      }),
    ),
    criticalLow: Type.Optional(
      Type.Number({
        ...LIMIT,
        description: 'At or below this the result is critical. Never above `low`.',
      }),
    ),
    criticalHigh: Type.Optional(
      Type.Number({
        ...LIMIT,
        description: 'At or above this the result is critical. Never below `high`.',
      }),
    ),
    note: Type.Optional(Type.String({ maxLength: NOTE_MAX, pattern: PLAIN_TEXT })),
  },
  {
    $id: 'LabRange',
    additionalProperties: false,
    description:
      'What is normal for one sex in one span of age: from `ageFrom`, included (the day the patient reaches it), until `ageUntil`, not included (that day belongs to the next range). No `ageUntil`: no upper age.',
  },
);
export type LabRange = Static<typeof LabRange>;

export const LabRanges = Type.Object(
  {
    labTestId: Type.String(),
    ranges: Type.Array(ref(LabRange), { maxItems: LIST_MAX }),
    version: Type.Integer(),
  },
  { $id: 'LabRanges' },
);
export type LabRanges = Static<typeof LabRanges>;

export const LabRangesUpdate = Type.Object(
  {
    ranges: Type.Array(ref(LabRange), { maxItems: LIST_MAX }),
    expectedVersion: Type.Integer(),
  },
  { $id: 'LabRangesUpdate', additionalProperties: false },
);
export type LabRangesUpdate = Static<typeof LabRangesUpdate>;

export const LabRangeResolved = Type.Object(
  {
    range: Type.Optional(ref(LabRange)),
  },
  {
    $id: 'LabRangeResolved',
    description: '`range` is absent when no row covers that age and sex.',
  },
);

export const LabRangeResolveQuery = Type.Object({
  ageValue: Type.Integer({ minimum: 0, maximum: AGE_VALUE_MAX }),
  ageUnit: StringEnum(AGE_UNITS),
  sex: StringEnum(PATIENT_SEXES),
});

export const LAB_TEST_SCHEMAS = [
  LabTestComponent,
  LabTest,
  LabTestPage,
  LabTestCreate,
  LabTestUpdate,
  LabTestSearchRequest,
  LabAge,
  LabRange,
  LabRanges,
  LabRangesUpdate,
  LabRangeResolved,
] as const;
