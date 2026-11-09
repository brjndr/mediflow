import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

function Enum<const Values extends readonly [string, ...string[]]>(
  id: string,
  values: Values,
  description?: string,
) {
  return Type.Unsafe<Values[number]>({
    $id: id,
    type: 'string',
    enum: [...values],
    ...(description ? { description } : {}),
  });
}

export const CASE_STATUSES = ['waiting', 'in_treatment', 'disposed'] as const;
export const ARRIVAL_MODES = ['walk_in', 'ambulance', 'police', 'referred'] as const;
export const SEXES = ['male', 'female', 'other', 'unknown'] as const;

export const EmergencyCaseStatus = Enum('EmergencyCaseStatus', CASE_STATUSES);
export const EmergencyArrivalMode = Enum('EmergencyArrivalMode', ARRIVAL_MODES);
export const EmergencySex = Enum('EmergencySex', SEXES);

const Category = Type.Integer({
  minimum: 1,
  maximum: 5,
  description: '1 immediate, 2 very urgent, 3 urgent, 4 less urgent, 5 non-urgent.',
});
const Version = Type.Integer({ minimum: 1 });

export const EmergencyCase = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    tempId: Type.String({ description: 'The temporary ID issued at arrival, e.g. ER-0042.' }),
    patientId: Type.Optional(
      Type.String({ description: 'Absent while the patient is unidentified.' }),
    ),
    alias: Type.Optional(
      Type.String({
        description: 'How an unidentified patient is described, e.g. "Man in blue jacket".',
      }),
    ),
    sex: ref(EmergencySex),
    approximateAge: Type.Optional(Type.Integer({ minimum: 0, maximum: 130 })),
    complaint: Type.String(),
    arrivalMode: ref(EmergencyArrivalMode),
    category: Type.Optional(Category),
    status: ref(EmergencyCaseStatus),
    arrivedAt: Type.String({ format: 'date-time' }),
    triagedAt: Type.Optional(Type.String({ format: 'date-time' })),
    identifiedAt: Type.Optional(Type.String({ format: 'date-time' })),
    version: Version,
  },
  { $id: 'EmergencyCase', additionalProperties: false },
);
export type EmergencyCase = Static<typeof EmergencyCase>;

export const EmergencyCasePage = CursorPage(ref(EmergencyCase), { $id: 'EmergencyCasePage' });

export const EmergencyCaseCreate = Type.Object(
  {
    patientId: Type.Optional(Type.String({ maxLength: 64 })),
    alias: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: PLAIN_TEXT })),
    sex: Type.Optional(ref(EmergencySex)),
    approximateAge: Type.Optional(Type.Integer({ minimum: 0, maximum: 130 })),
    complaint: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
    arrivalMode: ref(EmergencyArrivalMode),
    category: Type.Optional(Category),
  },
  { $id: 'EmergencyCaseCreate', additionalProperties: false },
);
export type EmergencyCaseCreate = Static<typeof EmergencyCaseCreate>;

export const EmergencyTriage = Type.Object(
  { category: Category, version: Version },
  { $id: 'EmergencyTriage', additionalProperties: false },
);
export const EmergencyIdentify = Type.Object(
  { patientId: Type.String({ maxLength: 64 }), version: Version },
  { $id: 'EmergencyIdentify', additionalProperties: false },
);
export const EmergencyUnidentify = Type.Object(
  {
    version: Version,
    reason: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
  },
  { $id: 'EmergencyUnidentify', additionalProperties: false },
);

export const EmergencyParams = Type.Object({ caseId: Type.String({ maxLength: 64 }) });
export const EmergencyListQuery = Type.Object({
  status: Type.Optional(ref(EmergencyCaseStatus)),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const EMERGENCY_SCHEMAS = [
  EmergencyCaseStatus,
  EmergencyArrivalMode,
  EmergencySex,
  EmergencyCase,
  EmergencyCasePage,
  EmergencyCaseCreate,
  EmergencyTriage,
  EmergencyIdentify,
  EmergencyUnidentify,
] as const;
