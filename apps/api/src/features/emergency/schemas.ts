import { Type, type Static } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

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
export const DISPOSITIONS = ['discharge', 'admit', 'refer', 'expired'] as const;
export const NOTE_KINDS = ['observation', 'assessment'] as const;
export const MLC_CATEGORIES = [
  'road_accident',
  'assault',
  'firearm_injury',
  'burns',
  'poisoning',
  'sexual_assault',
  'suspected_abuse',
  'suspicious_death',
  'other',
] as const;
export const NOTE_MAX = 2000;
export const DISPOSITION_NOTE_MAX = 500;

export const EmergencyCaseStatus = Enum('EmergencyCaseStatus', CASE_STATUSES);
export const EmergencyArrivalMode = Enum('EmergencyArrivalMode', ARRIVAL_MODES);
export const EmergencySex = Enum('EmergencySex', SEXES);
export const EmergencyDispositionType = Enum(
  'EmergencyDispositionType',
  DISPOSITIONS,
  'How the patient left the department.',
);
export const EmergencyNoteKind = Enum('EmergencyNoteKind', NOTE_KINDS);
export const EmergencyMlcCategory = Enum(
  'EmergencyMlcCategory',
  MLC_CATEGORIES,
  'Why the case is medico-legal.',
);

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
    encounterId: Type.Optional(
      Type.String({ description: 'The emergency encounter orders are placed on (ER-02).' }),
    ),
    disposition: Type.Optional(ref(EmergencyDispositionType)),
    disposedAt: Type.Optional(Type.String({ format: 'date-time' })),
    dispositionNote: Type.Optional(Type.String()),
    destination: Type.Optional(Type.String({ description: 'Where a referred patient went.' })),
    deathAt: Type.Optional(Type.String({ format: 'date-time' })),
    admissionId: Type.Optional(
      Type.String({ description: 'The inpatient admission an admit disposition made.' }),
    ),
    medicoLegal: Type.Boolean({
      description: 'Flagged medico-legal. The details need medicoLegal:read.',
    }),
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

export const EmergencyStart = Type.Object(
  { version: Version },
  { $id: 'EmergencyStart', additionalProperties: false },
);
export const EmergencyDisposition = Type.Object(
  {
    version: Version,
    type: ref(EmergencyDispositionType),
    note: Type.Optional(
      Type.String({ minLength: 1, maxLength: DISPOSITION_NOTE_MAX, pattern: PLAIN_LINES }),
    ),
    destination: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        pattern: PLAIN_TEXT,
        description: 'Required to refer.',
      }),
    ),
    deathAt: Type.Optional(
      Type.String({
        format: 'date-time',
        description: 'Required when expired; not in the future.',
      }),
    ),
    doctorId: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'To admit: the admitting doctor, else the caller’s own profile.',
      }),
    ),
  },
  { $id: 'EmergencyDisposition', additionalProperties: false },
);
export type EmergencyDisposition = Static<typeof EmergencyDisposition>;

export const EmergencyNote = Type.Object(
  {
    id: Type.String(),
    caseId: Type.String(),
    kind: ref(EmergencyNoteKind),
    body: Type.String(),
    authorName: Type.String(),
    createdAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'EmergencyNote', additionalProperties: false },
);
export type EmergencyNote = Static<typeof EmergencyNote>;
export const EmergencyNotePage = CursorPage(ref(EmergencyNote), { $id: 'EmergencyNotePage' });
export const EmergencyNoteCreate = Type.Object(
  {
    kind: ref(EmergencyNoteKind),
    body: Type.String({ minLength: 1, maxLength: NOTE_MAX, pattern: PLAIN_LINES }),
  },
  { $id: 'EmergencyNoteCreate', additionalProperties: false },
);
export type EmergencyNoteCreate = Static<typeof EmergencyNoteCreate>;
export const EmergencyNoteListQuery = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const EmergencyMlc = Type.Object(
  {
    caseId: Type.String(),
    revision: Type.Integer({ minimum: 1, description: 'Every change is a new revision.' }),
    category: ref(EmergencyMlcCategory),
    narrative: Type.String({ description: 'The injury and the history as given.' }),
    broughtBy: Type.Optional(Type.String()),
    policeInformed: Type.Boolean(),
    policeStation: Type.Optional(Type.String()),
    policeReference: Type.Optional(Type.String()),
    recordedByName: Type.String(),
    recordedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'EmergencyMlc', additionalProperties: false },
);
export type EmergencyMlc = Static<typeof EmergencyMlc>;
export const EmergencyMlcSave = Type.Object(
  {
    revision: Type.Integer({
      minimum: 0,
      description: 'The revision read; 0 to flag a case that has no record yet.',
    }),
    category: ref(EmergencyMlcCategory),
    narrative: Type.String({ minLength: 1, maxLength: 2000, pattern: PLAIN_LINES }),
    broughtBy: Type.Optional(Type.String({ minLength: 1, maxLength: 120, pattern: PLAIN_TEXT })),
    policeInformed: Type.Boolean(),
    policeStation: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 120,
        pattern: PLAIN_TEXT,
        description: 'Required when the police are informed.',
      }),
    ),
    policeReference: Type.Optional(
      Type.String({ minLength: 1, maxLength: 60, pattern: PLAIN_TEXT }),
    ),
  },
  { $id: 'EmergencyMlcSave', additionalProperties: false },
);
export type EmergencyMlcSave = Static<typeof EmergencyMlcSave>;

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
  EmergencyDispositionType,
  EmergencyNoteKind,
  EmergencyStart,
  EmergencyDisposition,
  EmergencyNote,
  EmergencyNotePage,
  EmergencyNoteCreate,
  EmergencyMlcCategory,
  EmergencyMlc,
  EmergencyMlcSave,
] as const;
