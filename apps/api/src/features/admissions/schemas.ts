import { Type, type Static } from '@sinclair/typebox';
import { PLAIN_TEXT } from '../../core/http/text.js';
import { CursorPage, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, ref } from '../../core/http/schemas.js';

// The enums carry an $id, unlike `StringEnum`, so the contract names them as the web app does.
export const ADMISSION_TYPES = ['planned', 'emergency', 'transfer_in'] as const;
export type AdmissionTypeValue = (typeof ADMISSION_TYPES)[number];
export const AdmissionType = Type.Unsafe<AdmissionTypeValue>({
  $id: 'AdmissionType',
  type: 'string',
  enum: [...ADMISSION_TYPES],
  description: 'How the patient came to be admitted.',
});

export const ADMISSION_STATUSES = ['admitted', 'discharged', 'cancelled'] as const;
export type AdmissionStatusValue = (typeof ADMISSION_STATUSES)[number];
export const AdmissionStatus = Type.Unsafe<AdmissionStatusValue>({
  $id: 'AdmissionStatus',
  type: 'string',
  enum: [...ADMISSION_STATUSES],
  description: 'admitted -> discharged or cancelled (made by mistake), both final.',
});

export const DISCHARGE_TYPES = [
  'routine',
  'against_advice',
  'referred',
  'absconded',
  'deceased',
] as const;
export type DischargeTypeValue = (typeof DISCHARGE_TYPES)[number];
export const DischargeType = Type.Unsafe<DischargeTypeValue>({
  $id: 'DischargeType',
  type: 'string',
  enum: [...DISCHARGE_TYPES],
  description: 'How the stay ended.',
});

export const RELEASE_REASONS = ['transfer', 'discharge', 'cancelled'] as const;
export type ReleaseReasonValue = (typeof RELEASE_REASONS)[number];
export const BedReleaseReason = Type.Unsafe<ReleaseReasonValue>({
  $id: 'BedReleaseReason',
  type: 'string',
  enum: [...RELEASE_REASONS],
  description: 'Why a patient left a bed.',
});

export const BOARD_BED_STATUSES = ['available', 'occupied', 'cleaning', 'blocked'] as const;
export type BoardBedStatusValue = (typeof BOARD_BED_STATUSES)[number];
export const BoardBedStatus = Type.Unsafe<BoardBedStatusValue>({
  $id: 'BoardBedStatus',
  type: 'string',
  enum: [...BOARD_BED_STATUSES],
  description:
    'available -> occupied (a patient is given the bed) -> cleaning (they leave) -> available (it is ready). blocked is set from the wards API.',
});

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({
  minimum: 1,
  description: 'The version the change was made from. Another one gives 409 `conflict`.',
});

export const AdmissionCreate = Type.Object(
  {
    patientId: Id,
    admissionType: ref(AdmissionType),
    doctorId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'The admitting doctor, a practising one. The caller’s own profile when left out (422 `unknown_doctor` when they have none). The stay’s department is theirs.',
      }),
    ),
    bedId: Type.Optional(
      Type.String({
        maxLength: 64,
        description:
          'An available bed to give the patient now. Left out, the patient is admitted without a bed and given one with assignBed.',
      }),
    ),
  },
  { $id: 'AdmissionCreate', additionalProperties: false },
);
export type AdmissionCreate = Static<typeof AdmissionCreate>;

export const AdmissionBed = Type.Object(
  {
    assignmentId: Type.String(),
    bedId: Type.String(),
    bedNumber: Type.String(),
    wardId: Type.String(),
    wardName: Type.String(),
    roomName: Type.String(),
    assignedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'AdmissionBed', additionalProperties: false },
);

export const Admission = Type.Object(
  {
    id: Type.String(),
    tenantId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    encounterId: Type.String({ description: 'The stay’s inpatient encounter.' }),
    doctorId: Type.String(),
    doctorName: Type.String(),
    departmentId: Type.String(),
    departmentName: Type.String(),
    admissionType: ref(AdmissionType),
    status: ref(AdmissionStatus),
    admittedAt: Type.String({ format: 'date-time' }),
    dischargedAt: Type.Optional(Type.String({ format: 'date-time' })),
    dischargeType: Type.Optional(ref(DischargeType)),
    cancelledAt: Type.Optional(Type.String({ format: 'date-time' })),
    cancelReason: Type.Optional(Type.String({ description: 'Why it was cancelled.' })),
    bed: Type.Optional(ref(AdmissionBed)),
    version: Type.Integer({ minimum: 1, description: 'Counts the changes, a change of bed too.' }),
  },
  { $id: 'Admission', additionalProperties: false },
);
export type Admission = Static<typeof Admission>;

export const AdmissionPage = CursorPage(ref(Admission), { $id: 'AdmissionPage' });

export const BedStay = Type.Object(
  {
    assignmentId: Type.String(),
    bedId: Type.String(),
    bedNumber: Type.String(),
    wardId: Type.String(),
    wardName: Type.String(),
    bedCategoryId: Type.String({
      description: 'The bed’s category when the patient was given it.',
    }),
    serviceId: Type.Optional(
      Type.String({ description: 'The bed-day service of that category then.' }),
    ),
    assignedAt: Type.String({ format: 'date-time' }),
    releasedAt: Type.Optional(Type.String({ format: 'date-time' })),
    releaseReason: Type.Optional(ref(BedReleaseReason)),
  },
  { $id: 'BedStay', additionalProperties: false },
);

export const AdmissionDetail = Type.Object(
  {
    admission: ref(Admission),
    stays: Type.Array(ref(BedStay), {
      description: 'Every bed the patient was in, oldest first: the bed history.',
    }),
  },
  { $id: 'AdmissionDetail', additionalProperties: false },
);

export const AdmissionListQuery = Type.Object({
  status: Type.Optional(ref(AdmissionStatus)),
  wardId: Type.Optional(Type.String({ maxLength: 64 })),
  patientId: Type.Optional(Type.String({ maxLength: 64 })),
  cursor: Type.Optional(Type.String({ maxLength: 300 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const AdmissionBedChange = Type.Object(
  { bedId: Id, version: Version },
  { additionalProperties: false },
);
export type AdmissionBedChange = Static<typeof AdmissionBedChange>;

export const AdmissionDischarge = Type.Object(
  { dischargeType: ref(DischargeType), version: Version },
  { additionalProperties: false },
);
export type AdmissionDischarge = Static<typeof AdmissionDischarge>;

export const CANCEL_REASON_MAX = 200;
export const AdmissionCancel = Type.Object(
  {
    reason: Type.String({
      minLength: 1,
      maxLength: CANCEL_REASON_MAX,
      pattern: PLAIN_TEXT,
      description: 'Plain text. Why it was cancelled: the admission was made by mistake.',
    }),
    version: Version,
  },
  { additionalProperties: false },
);
export type AdmissionCancel = Static<typeof AdmissionCancel>;

export const AdmissionParams = Type.Object({ admissionId: Type.String({ maxLength: 64 }) });
export const BedParams = Type.Object({ bedId: Type.String({ maxLength: 64 }) });

export const BoardOccupant = Type.Object(
  {
    admissionId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    assignedAt: Type.String({ format: 'date-time' }),
  },
  { $id: 'BoardOccupant', additionalProperties: false },
);

export const BoardBed = Type.Object(
  {
    id: Type.String(),
    number: Type.String(),
    wardId: Type.String(),
    wardName: Type.String(),
    roomId: Type.String(),
    roomName: Type.String(),
    categoryName: Type.String(),
    status: ref(BoardBedStatus),
    blockedReason: Type.Optional(
      Type.String({ description: 'Why a blocked bed is out of use, from a list.' }),
    ),
    occupant: Type.Optional(ref(BoardOccupant)),
    version: Type.Integer({ minimum: 1, description: 'The bed’s, for setBedHousekeeping.' }),
  },
  { $id: 'BoardBed', additionalProperties: false },
);
export type BoardBed = Static<typeof BoardBed>;

export const BoardBedPage = CursorPage(ref(BoardBed), { $id: 'BoardBedPage' });

export const BoardQuery = Type.Object({
  wardId: Type.Optional(Type.String({ maxLength: 64 })),
  status: Type.Optional(ref(BoardBedStatus)),
  cursor: Type.Optional(Type.String({ maxLength: 400 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
  ),
});

export const BedHousekeeping = Type.Object(
  {
    status: Type.Unsafe<'cleaning' | 'available'>({
      type: 'string',
      enum: ['cleaning', 'available'],
      description:
        '`cleaning` from an available bed, `available` (ready) from one being cleaned. 409 `invalid_transition` otherwise.',
    }),
    version: Version,
  },
  { additionalProperties: false },
);
export type BedHousekeeping = Static<typeof BedHousekeeping>;

export const ADMISSION_SCHEMAS = [
  AdmissionType,
  AdmissionStatus,
  DischargeType,
  BedReleaseReason,
  BoardBedStatus,
  AdmissionCreate,
  AdmissionBed,
  Admission,
  AdmissionPage,
  BedStay,
  AdmissionDetail,
  BoardOccupant,
  BoardBed,
  BoardBedPage,
] as const;
