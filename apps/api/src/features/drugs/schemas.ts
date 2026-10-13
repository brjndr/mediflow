import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, MAX_PAGE_SIZE, ref, StringEnum } from '../../core/http/schemas.js';

export const NAME_MAX = 150;
export const SHORT_MAX = 30;
export const REORDER_MAX = 1_000_000;
/** How many possible duplicates the check returns at most. */
export const DUPLICATES_MAX = 10;

export const DRUG_TYPES = ['medicine', 'consumable'] as const;
export type DrugType = (typeof DRUG_TYPES)[number];

export const DRUG_FORMS = [
  'tablet',
  'capsule',
  'syrup',
  'suspension',
  'injection',
  'infusion',
  'cream',
  'ointment',
  'drops',
  'inhaler',
  'powder',
  'device',
  'other',
] as const;
export type DrugForm = (typeof DRUG_FORMS)[number];

export const DRUG_SCHEDULES = ['none', 'h', 'h1', 'x', 'g', 'narcotic'] as const;
export type DrugSchedule = (typeof DRUG_SCHEDULES)[number];

export const TAX_CLASSES = ['exempt', 'reduced', 'standard', 'higher'] as const;
export type TaxClass = (typeof TAX_CLASSES)[number];

/**
 * Text that is safe to store and to print on a label: no control characters (the database
 * refuses a NUL, which would otherwise be a 500), no zero-width space, and none of the characters
 * that override the direction of text, which can make one name read as another. The joiners that
 * Indic scripts need (U+200C, U+200D) are allowed.
 */
const PLAIN_TEXT =
  '^[^\\u0000-\\u001F\\u007F-\\u009F\\u200B\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]*$';

const TypeSchema = StringEnum(DRUG_TYPES, {
  description: 'A medicine, or a consumable such as gloves or a syringe.',
});
const Form = StringEnum(DRUG_FORMS);
const Schedule = StringEnum(DRUG_SCHEDULES, {
  description:
    "The drug schedule the item falls under, recorded as a class. What each schedule requires (registers, prescriptions kept) is the pharmacy module's to enforce.",
});
const TaxClassSchema = StringEnum(TAX_CLASSES);
const GenericName = Type.String({
  minLength: 1,
  maxLength: NAME_MAX,
  pattern: PLAIN_TEXT,
  description: 'The generic name of a medicine, or what a consumable is.',
});
const BrandName = Type.String({ maxLength: NAME_MAX, pattern: PLAIN_TEXT });
const Strength = Type.String({
  maxLength: SHORT_MAX,
  pattern: PLAIN_TEXT,
  description: 'As written on the pack: "500 mg".',
});
const Unit = Type.String({
  maxLength: SHORT_MAX,
  pattern: PLAIN_TEXT,
  description: 'What one unit of stock is: "strip of 10", "100 ml bottle", "piece".',
});
const Controlled = Type.Boolean({
  description:
    'Whether it is handled as a controlled drug. Always true for schedule x and narcotic, whatever is sent.',
});
const ReorderLevel = Type.Integer({
  minimum: 0,
  maximum: REORDER_MAX,
  description: 'Stock at or below this many units is low. Absent: no level set.',
});

/**
 * A level or null, in a request. One schema with both types, not a union of two: the validator
 * coerces types, and with a union it coerces to whichever branch it tries first, so a null became
 * 0 or a 0 became null. It matches a value against the listed types before it coerces anything.
 */
const NullableReorderLevel = (description: string) =>
  Type.Unsafe<number | null>({
    type: ['integer', 'null'],
    minimum: 0,
    maximum: REORDER_MAX,
    description,
  });

export const Drug = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    type: TypeSchema,
    genericName: GenericName,
    brandName: Type.Optional(BrandName),
    form: Form,
    strength: Type.Optional(Strength),
    unit: Type.Optional(Unit),
    schedule: Schedule,
    controlled: Controlled,
    taxClass: TaxClassSchema,
    reorderLevel: Type.Optional(ReorderLevel),
    archived: Type.Boolean(),
    version: Type.Integer({ description: 'Counts the changes. Sent back as expectedVersion.' }),
  },
  {
    $id: 'Drug',
    description:
      'A medicine or a consumable the hospital keeps. What the item is, not what it costs or how much is in stock: those belong to the pharmacy and its batches. Holds no patient data.',
  },
);
export type Drug = Static<typeof Drug>;

export const DrugPage = CursorPage(ref(Drug), { $id: 'DrugPage' });

export const DrugCreate = Type.Object(
  {
    type: TypeSchema,
    genericName: GenericName,
    brandName: Type.Optional(BrandName),
    form: Form,
    strength: Type.Optional(Strength),
    unit: Type.Optional(Unit),
    schedule: Schedule,
    controlled: Type.Optional(Controlled),
    taxClass: TaxClassSchema,
    reorderLevel: Type.Optional(
      NullableReorderLevel('Stock at or below this many units is low. Absent or null: no level.'),
    ),
  },
  { $id: 'DrugCreate', additionalProperties: false },
);
export type DrugCreate = Static<typeof DrugCreate>;

export const DrugUpdate = Type.Object(
  {
    type: Type.Optional(TypeSchema),
    genericName: Type.Optional(GenericName),
    brandName: Type.Optional(BrandName),
    form: Type.Optional(Form),
    strength: Type.Optional(Strength),
    unit: Type.Optional(Unit),
    schedule: Type.Optional(Schedule),
    controlled: Type.Optional(Controlled),
    taxClass: Type.Optional(TaxClassSchema),
    reorderLevel: Type.Optional(
      NullableReorderLevel(
        'Null removes the level. An empty brand, strength or unit removes that too.',
      ),
    ),
    expectedVersion: Type.Integer(),
  },
  { $id: 'DrugUpdate', additionalProperties: false },
);
export type DrugUpdate = Static<typeof DrugUpdate>;

/**
 * In the body, never the query string: see Searches in the root CLAUDE.md. No default value on
 * the fields of a body: the generated client would make them required.
 */
export const DrugSearchRequest = Type.Object(
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
    q: Type.Optional(Type.String({ maxLength: 100, pattern: PLAIN_TEXT })),
    type: Type.Optional(StringEnum(DRUG_TYPES)),
    form: Type.Optional(Form),
    schedule: Type.Optional(StringEnum(DRUG_SCHEDULES)),
    controlled: Type.Optional(Type.Boolean({ description: 'True lists only controlled drugs.' })),
    archived: Type.Optional(
      Type.Boolean({
        description: 'True lists the archived items instead of the active ones. Absent: false.',
      }),
    ),
  },
  { $id: 'DrugSearchRequest', additionalProperties: false },
);
export type DrugSearchRequest = Static<typeof DrugSearchRequest>;

export const DrugDuplicateQuery = Type.Object(
  { genericName: GenericName, form: Form },
  { $id: 'DrugDuplicateQuery', additionalProperties: false },
);
export type DrugDuplicateQuery = Static<typeof DrugDuplicateQuery>;

export const DrugDuplicateMatches = Type.Object(
  { items: Type.Array(ref(Drug), { maxItems: DUPLICATES_MAX }) },
  { $id: 'DrugDuplicateMatches' },
);

export const DRUG_SCHEMAS = [
  Drug,
  DrugPage,
  DrugCreate,
  DrugUpdate,
  DrugSearchRequest,
  DrugDuplicateQuery,
  DrugDuplicateMatches,
] as const;
