import { Type, type Static } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';
import { DOSE_MAX, INSTRUCTIONS_MAX, LINES_MAX, MEDICATION_ROUTES } from '../clinical/index.js';

export const NAME_MAX = 100;
export const FAVOURITES_MAX = 20;
export { LINES_MAX };

const route = StringEnum(MEDICATION_ROUTES);
const Id = Type.String({ maxLength: 64 });

const lineFields = {
  drugId: Type.String({ maxLength: 64, description: 'A medicine of the catalog.' }),
  dose: Type.String({
    minLength: 1,
    maxLength: DOSE_MAX,
    pattern: PLAIN_TEXT,
    description: 'As written: "500 mg".',
  }),
  route,
  frequency: Type.String({
    minLength: 1,
    maxLength: DOSE_MAX,
    pattern: PLAIN_TEXT,
    description: 'As written: "1-0-1".',
  }),
  durationDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  quantity: Type.Optional(Type.Integer({ minimum: 1, maximum: 10000 })),
  instructions: Type.Optional(
    Type.String({ minLength: 1, maxLength: INSTRUCTIONS_MAX, pattern: PLAIN_LINES }),
  ),
};

export const PrescriptionSetLine = Type.Object(lineFields, {
  $id: 'PrescriptionSetLine',
  description: 'A medicine line of a set, as a prescription line has it.',
});
export type PrescriptionSetLine = Static<typeof PrescriptionSetLine>;

export const PrescriptionSetLineView = Type.Object(
  {
    ...lineFields,
    drugName: Type.String({ description: 'The medicine as the catalog names it now.' }),
    genericName: Type.String({
      description: 'The medicine’s generic name, for the allergy checks.',
    }),
    brandName: Type.Optional(Type.String()),
    drugArchived: Type.Boolean({
      description:
        'True when the medicine was archived after the set was saved: it cannot be prescribed.',
    }),
  },
  { $id: 'PrescriptionSetLineView' },
);

export const PrescriptionSet = Type.Object(
  {
    id: Id,
    tenantId: Type.String(),
    name: Type.String(),
    shared: Type.Boolean({
      description: 'True: shared with every prescriber. False: the caller’s own.',
    }),
    lineCount: Type.Integer({ minimum: 0 }),
    archived: Type.Boolean(),
    version: Type.Integer({ minimum: 1 }),
    updatedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'PrescriptionSet', description: 'A prescription set. Holds no patient data.' },
);
export type PrescriptionSet = Static<typeof PrescriptionSet>;

export const PrescriptionSetPage = CursorPage(ref(PrescriptionSet), { $id: 'PrescriptionSetPage' });

export const PrescriptionSetDetail = Type.Object(
  {
    set: ref(PrescriptionSet),
    lines: Type.Array(ref(PrescriptionSetLineView), { description: 'In the order written.' }),
  },
  { $id: 'PrescriptionSetDetail' },
);
export type PrescriptionSetDetail = Static<typeof PrescriptionSetDetail>;

const name = Type.String({ minLength: 1, maxLength: NAME_MAX, pattern: PLAIN_TEXT });
const lines = Type.Array(ref(PrescriptionSetLine), { minItems: 1, maxItems: LINES_MAX });

export const PrescriptionSetCreate = Type.Object(
  {
    name,
    shared: Type.Optional(
      Type.Boolean({
        description:
          'Share with the whole hospital (needs prescriptionSet:manageShared). Omitted: the caller’s own.',
      }),
    ),
    lines,
  },
  { $id: 'PrescriptionSetCreate' },
);
export type PrescriptionSetCreate = Static<typeof PrescriptionSetCreate>;

export const PrescriptionSetUpdate = Type.Object(
  {
    version: Type.Integer({
      minimum: 1,
      description: 'The version the change was made from. Another one gives 409 `conflict`.',
    }),
    name: Type.Optional(name),
    archived: Type.Optional(Type.Boolean()),
    lines: Type.Optional(lines),
  },
  { $id: 'PrescriptionSetUpdate' },
);
export type PrescriptionSetUpdate = Static<typeof PrescriptionSetUpdate>;

export const PrescriptionSetListQuery = Type.Object({
  cursor: Type.Optional(
    Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
  ),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
  archived: Type.Optional(
    Type.Boolean({ description: 'True: the archived sets. Default: those in use.' }),
  ),
});

export const FavouriteDrug = Type.Object(
  {
    drugId: Id,
    name: Type.String(),
    archived: Type.Boolean({
      description: 'Archived after it was starred: it cannot be prescribed.',
    }),
  },
  { $id: 'FavouriteDrug' },
);

export const FavouriteDrugs = Type.Object(
  { items: Type.Array(ref(FavouriteDrug), { description: 'In the order the doctor put them.' }) },
  { $id: 'FavouriteDrugs' },
);

export const FavouriteDrugsSet = Type.Object(
  {
    drugIds: Type.Array(Type.String({ maxLength: 64 }), {
      maxItems: FAVOURITES_MAX,
      description: 'The whole list, in order. Replaces the caller’s favourites.',
    }),
  },
  { $id: 'FavouriteDrugsSet' },
);

export const PRESCRIPTION_SET_SCHEMAS = [
  PrescriptionSetLine,
  PrescriptionSetLineView,
  PrescriptionSet,
  PrescriptionSetPage,
  PrescriptionSetDetail,
  PrescriptionSetCreate,
  PrescriptionSetUpdate,
  FavouriteDrug,
  FavouriteDrugs,
  FavouriteDrugsSet,
] as const;
export type FavouriteDrugsSet = Static<typeof FavouriteDrugsSet>;
