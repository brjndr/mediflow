import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';
import { PLAIN_LINES, PLAIN_TEXT } from '../../core/http/text.js';

export const REASON_MAX = 200;
export const DIAGNOSIS_TEXT_MAX = 300;
export const INSTRUCTIONS_MAX = 500;
export const ADVICE_MAX = 1000;
export const DOSE_MAX = 50;
export const LINES_MAX = 30;

// The enums carry an $id, unlike `StringEnum`, so the contract names them for the web app.
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

export const ENCOUNTER_TYPES = ['opd', 'ipd', 'er', 'daycare'] as const;
export const EncounterType = named(
  'EncounterType',
  ENCOUNTER_TYPES,
  'The kind of visit. The API opens `opd` encounters; the others come with their modules.',
);
export const ENCOUNTER_STATUSES = ['open', 'closed', 'cancelled'] as const;
export type EncounterStatusValue = (typeof ENCOUNTER_STATUSES)[number];
export const EncounterStatus = named('EncounterStatus', ENCOUNTER_STATUSES);

export const NOTE_STATUSES = ['draft', 'signed'] as const;
export const NoteStatus = named('ClinicalNoteStatus', NOTE_STATUSES);

export const DIAGNOSIS_KINDS = ['provisional', 'final'] as const;
export const DiagnosisKind = named('DiagnosisKind', DIAGNOSIS_KINDS);

export const ORDER_TYPES = ['lab', 'imaging', 'procedure', 'medication', 'diet'] as const;
export type OrderTypeValue = (typeof ORDER_TYPES)[number];
export const OrderType = named('OrderType', ORDER_TYPES);
/** What is ordered on its own; medication is ordered through a prescription. */
export const PLACED_TYPES = ['lab', 'imaging', 'procedure', 'diet'] as const;
export const PlacedOrderType = named(
  'PlacedOrderType',
  PLACED_TYPES,
  'An order placed on its own. Medication is ordered through a prescription.',
);
export const ORDER_STATUSES = [
  'placed',
  'accepted',
  'in_progress',
  'completed',
  'cancelled',
] as const;
export type OrderStatusValue = (typeof ORDER_STATUSES)[number];
export const OrderStatus = named('OrderStatus', ORDER_STATUSES);
/** Where an order may be moved on to; cancelling has its own route. */
export const PROGRESS_STATUSES = ['accepted', 'in_progress', 'completed'] as const;
export const OrderProgressStatus = named(
  'OrderProgressStatus',
  PROGRESS_STATUSES,
  'placed -> accepted -> in_progress -> completed, one step at a time.',
);
export const PRIORITIES = ['routine', 'urgent', 'stat'] as const;
export const OrderPriority = named('OrderPriority', PRIORITIES);
export const ROUTES = [
  'oral',
  'sublingual',
  'topical',
  'inhaled',
  'nasal',
  'eye',
  'ear',
  'rectal',
  'vaginal',
  'intramuscular',
  'intravenous',
  'subcutaneous',
  'other',
] as const;
export const MedicationRoute = named('MedicationRoute', ROUTES);

const Id = Type.String({ maxLength: 64 });
const Instant = Type.String({ format: 'date-time' });
const Version = Type.Integer({
  minimum: 1,
  description: 'The version the change was made from. Another one gives 409 `conflict`.',
});
const Reason = (description: string) =>
  Type.String({
    minLength: 1,
    maxLength: REASON_MAX,
    pattern: PLAIN_TEXT,
    description: `Plain text. ${description}`,
  });
const Instructions = Type.String({
  minLength: 1,
  maxLength: INSTRUCTIONS_MAX,
  pattern: PLAIN_LINES,
  description: 'Plain text of one or more lines.',
});
const NoteBody = Type.Unsafe<Record<string, unknown>>({
  type: 'object',
  additionalProperties: true,
  description:
    'The rich text document of the app (paragraphs, headings, lists, quotes and marks), never HTML. Reduced to that allowlist on the way in; an empty document is refused.',
});

const object = <Properties extends Record<string, TSchema>>(
  $id: string,
  properties: Properties,
  description?: string,
) =>
  Type.Object(properties, {
    $id,
    additionalProperties: false,
    ...(description ? { description } : {}),
  });

export const Encounter = object(
  'Encounter',
  {
    id: Type.String(),
    tenantId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    type: ref(EncounterType),
    status: ref(EncounterStatus),
    appointmentId: Type.Optional(Type.String()),
    queueTokenId: Type.Optional(Type.String()),
    attendingDoctorId: Type.Optional(Type.String()),
    attendingDoctorName: Type.Optional(Type.String()),
    departmentId: Type.Optional(Type.String()),
    departmentName: Type.Optional(Type.String()),
    openedAt: Instant,
    openedByName: Type.String(),
    endedAt: Type.Optional(
      Type.String({ format: 'date-time', description: 'When it was closed or cancelled.' }),
    ),
    endedByName: Type.Optional(Type.String()),
    cancelReason: Type.Optional(Type.String()),
    version: Type.Integer({ minimum: 1 }),
  },
  'A visit of one patient, which every clinical, ordering and billing record attaches to.',
);
export type Encounter = Static<typeof Encounter>;
export const EncounterPage = CursorPage(ref(Encounter), { $id: 'EncounterPage' });

export const EncounterCreate = object(
  'EncounterCreate',
  {
    patientId: Id,
    queueTokenId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'The patient’s token of today the consultation is for. Gives the doctor when none is sent.',
      }),
    ),
    appointmentId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'The patient’s appointment the consultation is for. Gives the doctor when none is sent and the token gives none.',
      }),
    ),
    attendingDoctorId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'The doctor. When absent: the token’s doctor, the appointment’s, or the caller’s own profile.',
      }),
    ),
  },
  'Starts an OPD encounter: from a queue token, an appointment, or a walk-in with neither.',
);
export type EncounterCreate = Static<typeof EncounterCreate>;

export const EncounterClose = object('EncounterClose', { version: Version });
export type EncounterClose = Static<typeof EncounterClose>;
export const EncounterCancel = object('EncounterCancel', {
  version: Version,
  reason: Reason('Why it was cancelled: it was opened by mistake.'),
});
export type EncounterCancel = Static<typeof EncounterCancel>;

export const ClinicalNote = object(
  'ClinicalNote',
  {
    id: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    status: ref(NoteStatus),
    body: NoteBody,
    authorId: Type.String(),
    authorName: Type.String(),
    createdAt: Instant,
    updatedAt: Instant,
    signedAt: Type.Optional(Instant),
    amendsId: Type.Optional(
      Type.String({ description: 'The signed note this one amends. That note is kept as it was.' }),
    ),
    amendmentReason: Type.Optional(Type.String()),
    amendedById: Type.Optional(
      Type.String({ description: 'The note that amends this one: read that one instead.' }),
    ),
    version: Type.Integer({ minimum: 1 }),
  },
  'A clinical note: a draft its author edits, then signed and never changed again.',
);
export const ClinicalNotePage = CursorPage(ref(ClinicalNote), { $id: 'ClinicalNotePage' });

export const ClinicalNoteCreate = object('ClinicalNoteCreate', { body: NoteBody });
export type ClinicalNoteCreate = Static<typeof ClinicalNoteCreate>;
export const ClinicalNoteUpdate = object('ClinicalNoteUpdate', {
  body: NoteBody,
  version: Version,
});
export type ClinicalNoteUpdate = Static<typeof ClinicalNoteUpdate>;
export const ClinicalNoteSign = object('ClinicalNoteSign', { version: Version });
export type ClinicalNoteSign = Static<typeof ClinicalNoteSign>;
export const ClinicalNoteAmend = object('ClinicalNoteAmend', {
  body: NoteBody,
  reason: Reason('What the amendment corrects or adds.'),
});
export type ClinicalNoteAmend = Static<typeof ClinicalNoteAmend>;

export const Diagnosis = object(
  'Diagnosis',
  {
    id: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    codeId: Type.Optional(Type.String()),
    code: Type.Optional(Type.String({ description: 'As the code read when recorded.' })),
    codeTitle: Type.Optional(Type.String({ description: 'As the title read when recorded.' })),
    text: Type.Optional(Type.String()),
    kind: ref(DiagnosisKind),
    recordedAt: Instant,
    recordedByName: Type.String(),
    retractedAt: Type.Optional(Instant),
    retractedByName: Type.Optional(Type.String()),
    retractionReason: Type.Optional(Type.String()),
  },
  'A diagnosis of an encounter. Never changed; retracted with a reason, and kept.',
);
export const DiagnosisPage = CursorPage(ref(Diagnosis), { $id: 'DiagnosisPage' });

export const DiagnosisCreate = object('DiagnosisCreate', {
  codeId: Type.Optional(
    Type.String({ maxLength: 64, description: 'An ICD-10 code, from the code search.' }),
  ),
  text: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: DIAGNOSIS_TEXT_MAX,
      pattern: PLAIN_TEXT,
      description: 'Plain text: the diagnosis in words, alone or beside the code.',
    }),
  ),
  kind: ref(DiagnosisKind),
});
export type DiagnosisCreate = Static<typeof DiagnosisCreate>;
export const DiagnosisRetract = object('DiagnosisRetract', {
  reason: Reason('Why it no longer stands: entered in error, ruled out.'),
});
export type DiagnosisRetract = Static<typeof DiagnosisRetract>;

export const Order = object(
  'Order',
  {
    id: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    type: ref(OrderType),
    labTestId: Type.Optional(Type.String()),
    serviceId: Type.Optional(Type.String()),
    drugId: Type.Optional(Type.String()),
    prescriptionId: Type.Optional(Type.String()),
    lineNumber: Type.Optional(
      Type.Integer({
        minimum: 1,
        description:
          'Its place in its prescription, from 1. The lines of one prescription share placedAt.',
      }),
    ),
    itemCode: Type.Optional(Type.String()),
    itemName: Type.Optional(
      Type.String({ description: 'What was ordered, as it read then. A diet order has none.' }),
    ),
    status: ref(OrderStatus),
    priority: ref(OrderPriority),
    instructions: Type.Optional(Type.String()),
    dose: Type.Optional(Type.String()),
    route: Type.Optional(ref(MedicationRoute)),
    frequency: Type.Optional(Type.String()),
    durationDays: Type.Optional(Type.Integer()),
    quantity: Type.Optional(Type.Integer()),
    placedAt: Instant,
    orderedById: Type.String(),
    orderedByName: Type.String(),
    statusChangedAt: Type.Optional(Instant),
    cancelReason: Type.Optional(Type.String()),
    version: Type.Integer({ minimum: 1 }),
  },
  'A request for work for the patient: one table for lab, imaging, procedure, medication and diet.',
);
export const OrderPage = CursorPage(ref(Order), { $id: 'OrderPage' });

export const OrderCreate = object(
  'OrderCreate',
  {
    type: ref(PlacedOrderType),
    labTestId: Type.Optional(
      Type.String({ maxLength: 64, description: 'For `lab`: a test or panel of the catalog.' }),
    ),
    serviceId: Type.Optional(
      Type.String({
        maxLength: 64,
        description: 'For `imaging` and `procedure`: a service of that category.',
      }),
    ),
    priority: Type.Optional(ref(OrderPriority)),
    instructions: Type.Optional(Instructions),
  },
  'Exactly the catalog id its type takes; a diet order takes none and needs instructions. The priority is `routine` when absent.',
);
export type OrderCreate = Static<typeof OrderCreate>;
export const OrderStatusChange = object('OrderStatusChange', {
  status: ref(OrderProgressStatus),
  version: Version,
});
export type OrderStatusChange = Static<typeof OrderStatusChange>;
export const OrderCancel = object('OrderCancel', {
  version: Version,
  reason: Reason('Why it was cancelled.'),
});
export type OrderCancel = Static<typeof OrderCancel>;

export const Prescription = object(
  'Prescription',
  {
    id: Type.String(),
    tenantId: Type.String(),
    encounterId: Type.String(),
    patientId: Type.String(),
    prescribedAt: Instant,
    prescribedById: Type.String(),
    prescribedByName: Type.String(),
    advice: Type.Optional(Type.String()),
    replacesId: Type.Optional(Type.String()),
    replaceReason: Type.Optional(Type.String()),
    replacedById: Type.Optional(
      Type.String({ description: 'The prescription that replaces this one.' }),
    ),
    lines: Type.Array(ref(Order), { description: 'Its medication orders, in the order written.' }),
  },
  'A prescription: medication orders written together, never changed. A revision replaces it.',
);
export const PrescriptionPage = CursorPage(ref(Prescription), { $id: 'PrescriptionPage' });

export const PrescriptionLine = object('PrescriptionLine', {
  drugId: Type.String({ maxLength: 64, description: 'A medicine of the catalog.' }),
  dose: Type.String({
    minLength: 1,
    maxLength: DOSE_MAX,
    pattern: PLAIN_TEXT,
    description: 'As written: "500 mg", "1 tablet".',
  }),
  route: ref(MedicationRoute),
  frequency: Type.String({
    minLength: 1,
    maxLength: DOSE_MAX,
    pattern: PLAIN_TEXT,
    description: 'As written: "1-0-1", "every 8 hours".',
  }),
  durationDays: Type.Optional(Type.Integer({ minimum: 1, maximum: 365 })),
  quantity: Type.Optional(
    Type.Integer({ minimum: 1, maximum: 10000, description: 'How many units to dispense.' }),
  ),
  instructions: Type.Optional(Instructions),
});
export type PrescriptionLine = Static<typeof PrescriptionLine>;

export const PrescriptionCreate = object('PrescriptionCreate', {
  lines: Type.Array(ref(PrescriptionLine), { minItems: 1, maxItems: LINES_MAX }),
  advice: Type.Optional(
    Type.String({
      minLength: 1,
      maxLength: ADVICE_MAX,
      pattern: PLAIN_LINES,
      description: 'Advice for the patient. Plain text of one or more lines.',
    }),
  ),
  replacesId: Type.Optional(
    Type.String({
      maxLength: 64,
      description:
        'A prescription of the same encounter this one replaces. Its orders not yet started are cancelled.',
    }),
  ),
  replaceReason: Type.Optional(Reason('Required with replacesId, refused without it.')),
});
export type PrescriptionCreate = Static<typeof PrescriptionCreate>;

export const EncounterParams = Type.Object({ encounterId: Id });
export const NoteParams = Type.Object({ noteId: Id });
export const DiagnosisParams = Type.Object({ diagnosisId: Id });
export const OrderParams = Type.Object({ orderId: Id });
export const PrescriptionParams = Type.Object({ prescriptionId: Id });

const Limit = Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE });
const CursorParam = Type.Optional(
  Type.String({ description: 'Opaque. Pass the nextCursor of the previous page.' }),
);

export const EncounterListQuery = Type.Object({
  patientId: Type.Optional(Id),
  attendingDoctorId: Type.Optional(Id),
  status: Type.Optional(ref(EncounterStatus)),
  cursor: CursorParam,
  limit: Limit,
});
export const PageQuery = Type.Object({ cursor: CursorParam, limit: Limit });
export const OrderListQuery = Type.Object({
  type: Type.Optional(ref(OrderType)),
  cursor: CursorParam,
  limit: Limit,
});

export const CLINICAL_SCHEMAS = [
  EncounterType,
  EncounterStatus,
  NoteStatus,
  DiagnosisKind,
  OrderType,
  PlacedOrderType,
  OrderStatus,
  OrderProgressStatus,
  OrderPriority,
  MedicationRoute,
  Encounter,
  EncounterPage,
  EncounterCreate,
  EncounterClose,
  EncounterCancel,
  ClinicalNote,
  ClinicalNotePage,
  ClinicalNoteCreate,
  ClinicalNoteUpdate,
  ClinicalNoteSign,
  ClinicalNoteAmend,
  Diagnosis,
  DiagnosisPage,
  DiagnosisCreate,
  DiagnosisRetract,
  Order,
  OrderPage,
  OrderCreate,
  OrderStatusChange,
  OrderCancel,
  Prescription,
  PrescriptionPage,
  PrescriptionLine,
  PrescriptionCreate,
] as const;
