import { Type, type Static, type TSchema } from '@sinclair/typebox';
import {
  CursorPage,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT } from '../../core/http/text.js';

// The enums carry an $id, so the contract names them for the web app.
function Enum<const Values extends readonly [string, ...string[]]>(
  id: string,
  values: Values,
  description: string,
) {
  return Type.Unsafe<Values[number]>({ $id: id, type: 'string', enum: [...values], description });
}

const Id = Type.String({ maxLength: 64 });
const Version = Type.Integer({
  minimum: 1,
  description: 'The version the change was made from. Another one gives 409 `conflict`.',
});
const When = Type.String({ format: 'date-time' });
const Limit = Type.Optional(
  Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, default: DEFAULT_PAGE_SIZE }),
);
const Cursor = Type.Optional(Type.String({ maxLength: 300 }));

function Obj<T extends Record<string, TSchema>>(id: string, properties: T) {
  return Type.Object(properties, { $id: id, additionalProperties: false });
}

// --- roster ------------------------------------------------------------------------------------

export const SHIFT_KINDS = ['morning', 'evening', 'night', 'day', 'on_call'] as const;
export const ShiftKind = Enum('ShiftKind', SHIFT_KINDS, 'What kind of duty a shift is.');
export const ShiftStatus = Enum(
  'ShiftStatus',
  ['scheduled', 'cancelled'] as const,
  'scheduled -> cancelled, final.',
);

export const RosterShift = Obj('RosterShift', {
  id: Type.String(),
  tenantId: Type.String(),
  userId: Type.String(),
  userName: Type.String(),
  departmentId: Type.Optional(Type.String()),
  departmentName: Type.Optional(Type.String()),
  shiftKind: ref(ShiftKind),
  startsAt: When,
  endsAt: When,
  status: ref(ShiftStatus),
  version: Type.Integer({ minimum: 1 }),
});
export type RosterShift = Static<typeof RosterShift>;
export const RosterShiftPage = CursorPage(ref(RosterShift), { $id: 'RosterShiftPage' });

export const RosterShiftCreate = Type.Object(
  {
    userId: Id,
    departmentId: Type.Optional(Id),
    shiftKind: ref(ShiftKind),
    startsAt: When,
    endsAt: Type.String({
      format: 'date-time',
      description: 'After the start, and at most 24 hours later.',
    }),
  },
  { $id: 'RosterShiftCreate', additionalProperties: false },
);
export type RosterShiftCreate = Static<typeof RosterShiftCreate>;

export const RosterShiftListQuery = Type.Object({
  from: Type.Optional(When),
  to: Type.Optional(When),
  userId: Type.Optional(Id),
  departmentId: Type.Optional(Id),
  includeCancelled: Type.Optional(Type.Boolean()),
  cursor: Cursor,
  limit: Limit,
});

export const VersionBody = Type.Object({ version: Version }, { additionalProperties: false });
export type VersionBody = Static<typeof VersionBody>;
export const ShiftParams = Type.Object({ shiftId: Id });

// --- blood bank --------------------------------------------------------------------------------

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;
export const BloodGroup = Enum('BloodGroup', BLOOD_GROUPS, 'ABO and Rh group.');
export const BLOOD_COMPONENTS = [
  'whole_blood',
  'red_cells',
  'plasma',
  'platelets',
  'cryo',
] as const;
export const BloodComponent = Enum('BloodComponent', BLOOD_COMPONENTS, 'What the unit holds.');
export const BLOOD_UNIT_STATUSES = [
  'collected',
  'testing',
  'available',
  'reserved',
  'issued',
  'transfused',
  'discarded',
  'expired',
] as const;
export type BloodUnitStatusValue = (typeof BLOOD_UNIT_STATUSES)[number];
export const BloodUnitStatus = Enum(
  'BloodUnitStatus',
  BLOOD_UNIT_STATUSES,
  'collected -> testing -> available -> reserved -> issued -> transfused. Discarded from any state before transfusion; available or reserved units past their date are expired; reserved goes back to available when released.',
);

export const BloodUnit = Obj('BloodUnit', {
  id: Type.String(),
  tenantId: Type.String(),
  unitNumber: Type.String(),
  bloodGroup: ref(BloodGroup),
  component: ref(BloodComponent),
  volumeMl: Type.Integer(),
  collectedAt: When,
  expiresAt: When,
  status: ref(BloodUnitStatus),
  patientId: Type.Optional(
    Type.String({ description: 'The patient it is held for, issued to or went to.' }),
  ),
  version: Type.Integer({ minimum: 1 }),
});
export type BloodUnit = Static<typeof BloodUnit>;
export const BloodUnitPage = CursorPage(ref(BloodUnit), { $id: 'BloodUnitPage' });

export const BloodUnitEntry = Obj('BloodUnitEntry', {
  fromStatus: Type.Optional(ref(BloodUnitStatus)),
  toStatus: ref(BloodUnitStatus),
  patientId: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  actorId: Type.String(),
  occurredAt: When,
});
export const BloodUnitDetail = Obj('BloodUnitDetail', {
  unit: ref(BloodUnit),
  history: Type.Array(ref(BloodUnitEntry), { description: 'Every move, oldest first.' }),
});

export const BloodUnitCreate = Type.Object(
  {
    unitNumber: Type.String({ minLength: 1, maxLength: 40, pattern: PLAIN_TEXT }),
    bloodGroup: ref(BloodGroup),
    component: ref(BloodComponent),
    volumeMl: Type.Integer({ minimum: 10, maximum: 1000 }),
    collectedAt: When,
    expiresAt: Type.String({ format: 'date-time', description: 'After the collection.' }),
  },
  { $id: 'BloodUnitCreate', additionalProperties: false },
);
export type BloodUnitCreate = Static<typeof BloodUnitCreate>;

export const BloodUnitMove = Type.Object(
  {
    to: StringEnum(
      ['testing', 'available', 'reserved', 'issued', 'transfused', 'discarded', 'expired'] as const,
      { description: 'The status to move to.' },
    ),
    version: Version,
    patientId: Type.Optional(
      Type.String({ maxLength: 64, description: 'Required to reserve a unit.' }),
    ),
    reason: Type.Optional(
      Type.String({
        minLength: 1,
        maxLength: 500,
        pattern: PLAIN_TEXT,
        description:
          'Required to discard, and for a unit that failed its tests. Kept with the move.',
      }),
    ),
  },
  { $id: 'BloodUnitMove', additionalProperties: false },
);
export type BloodUnitMove = Static<typeof BloodUnitMove>;

export const BloodUnitListQuery = Type.Object({
  status: Type.Optional(ref(BloodUnitStatus)),
  bloodGroup: Type.Optional(ref(BloodGroup)),
  component: Type.Optional(ref(BloodComponent)),
  patientId: Type.Optional(Id),
  cursor: Cursor,
  limit: Limit,
});
export const BloodUnitParams = Type.Object({ unitId: Id });

export const BloodStockRow = Obj('BloodStockRow', {
  bloodGroup: ref(BloodGroup),
  component: ref(BloodComponent),
  available: Type.Integer({ description: 'Units cleared and not past their date.' }),
  reserved: Type.Integer(),
  nextExpiry: Type.Optional(When),
});
export const BloodStock = Obj('BloodStock', { items: Type.Array(ref(BloodStockRow)) });

// --- ambulances --------------------------------------------------------------------------------

export const AmbulanceKind = Enum(
  'AmbulanceKind',
  ['basic', 'advanced', 'neonatal'] as const,
  'How well equipped an ambulance is.',
);
export const AmbulanceStatus = Enum(
  'AmbulanceStatus',
  ['available', 'on_trip', 'out_of_service'] as const,
  'on_trip is set by dispatching and cleared when the trip ends; out_of_service is set by hand.',
);
export const Ambulance = Obj('Ambulance', {
  id: Type.String(),
  tenantId: Type.String(),
  registration: Type.String(),
  kind: ref(AmbulanceKind),
  status: ref(AmbulanceStatus),
  version: Type.Integer({ minimum: 1 }),
});
export type Ambulance = Static<typeof Ambulance>;
export const AmbulancePage = CursorPage(ref(Ambulance), { $id: 'AmbulancePage' });

export const AmbulanceCreate = Type.Object(
  {
    registration: Type.String({ minLength: 1, maxLength: 20, pattern: PLAIN_TEXT }),
    kind: ref(AmbulanceKind),
  },
  { $id: 'AmbulanceCreate', additionalProperties: false },
);
export type AmbulanceCreate = Static<typeof AmbulanceCreate>;

export const AmbulanceServiceChange = Type.Object(
  {
    status: StringEnum(['available', 'out_of_service'] as const, {
      description: 'Only these two are set by hand.',
    }),
    version: Version,
  },
  { $id: 'AmbulanceServiceChange', additionalProperties: false },
);
export type AmbulanceServiceChange = Static<typeof AmbulanceServiceChange>;
export const AmbulanceParams = Type.Object({ ambulanceId: Id });
export const AmbulanceListQuery = Type.Object({
  status: Type.Optional(ref(AmbulanceStatus)),
  cursor: Cursor,
  limit: Limit,
});

export const TripStatus = Enum(
  'AmbulanceTripStatus',
  ['requested', 'dispatched', 'picked_up', 'completed', 'cancelled'] as const,
  'requested -> dispatched -> picked_up -> completed; cancelled before the pick-up.',
);
export const AmbulanceTrip = Obj('AmbulanceTrip', {
  id: Type.String(),
  tenantId: Type.String(),
  patientId: Type.Optional(Type.String()),
  ambulanceId: Type.Optional(Type.String()),
  ambulanceRegistration: Type.Optional(Type.String()),
  pickup: Type.String(),
  destination: Type.String(),
  status: ref(TripStatus),
  requestedAt: When,
  dispatchedAt: Type.Optional(When),
  pickedUpAt: Type.Optional(When),
  finishedAt: Type.Optional(When),
  version: Type.Integer({ minimum: 1 }),
});
export type AmbulanceTrip = Static<typeof AmbulanceTrip>;
export const AmbulanceTripPage = CursorPage(ref(AmbulanceTrip), { $id: 'AmbulanceTripPage' });

export const AmbulanceTripCreate = Type.Object(
  {
    patientId: Type.Optional(
      Type.String({ maxLength: 64, description: 'Left out for an emergency with no record yet.' }),
    ),
    pickup: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
    destination: Type.String({ minLength: 1, maxLength: 300, pattern: PLAIN_TEXT }),
  },
  { $id: 'AmbulanceTripCreate', additionalProperties: false },
);
export type AmbulanceTripCreate = Static<typeof AmbulanceTripCreate>;

export const AmbulanceTripMove = Type.Object(
  {
    to: StringEnum(['dispatched', 'picked_up', 'completed', 'cancelled'] as const, {
      description: 'The status to move to.',
    }),
    version: Version,
    ambulanceId: Type.Optional(
      Type.String({ maxLength: 64, description: 'Required to dispatch.' }),
    ),
  },
  { $id: 'AmbulanceTripMove', additionalProperties: false },
);
export type AmbulanceTripMove = Static<typeof AmbulanceTripMove>;
export const TripParams = Type.Object({ tripId: Id });
export const TripListQuery = Type.Object({
  status: Type.Optional(ref(TripStatus)),
  ambulanceId: Type.Optional(Id),
  cursor: Cursor,
  limit: Limit,
});

// --- cleaning tasks ----------------------------------------------------------------------------

export const CleaningKind = Enum(
  'CleaningKind',
  ['discharge', 'routine'] as const,
  'discharge is made when a patient leaves a bed; routine is asked for.',
);
export const CleaningStatus = Enum(
  'CleaningTaskStatus',
  ['open', 'in_progress', 'done', 'cancelled'] as const,
  'open -> in_progress -> done; cancelled before it is done. Done makes the bed available.',
);
export const CleaningTask = Obj('CleaningTask', {
  id: Type.String(),
  tenantId: Type.String(),
  bedId: Type.String(),
  bedNumber: Type.String(),
  wardId: Type.String(),
  wardName: Type.String(),
  kind: ref(CleaningKind),
  status: ref(CleaningStatus),
  assignedTo: Type.Optional(Type.String()),
  assignedToName: Type.Optional(Type.String()),
  createdAt: When,
  startedAt: Type.Optional(When),
  finishedAt: Type.Optional(When),
  version: Type.Integer({ minimum: 1 }),
});
export type CleaningTask = Static<typeof CleaningTask>;
export const CleaningTaskPage = CursorPage(ref(CleaningTask), { $id: 'CleaningTaskPage' });

export const CleaningTaskCreate = Type.Object(
  { bedId: Id, assignedTo: Type.Optional(Id) },
  { $id: 'CleaningTaskCreate', additionalProperties: false },
);
export type CleaningTaskCreate = Static<typeof CleaningTaskCreate>;

export const CleaningTaskMove = Type.Object(
  {
    to: StringEnum(['in_progress', 'done', 'cancelled'] as const, {
      description: 'The status to move to.',
    }),
    version: Version,
  },
  { $id: 'CleaningTaskMove', additionalProperties: false },
);
export type CleaningTaskMove = Static<typeof CleaningTaskMove>;
export const CleaningTaskParams = Type.Object({ taskId: Id });
export const CleaningTaskListQuery = Type.Object({
  status: Type.Optional(ref(CleaningStatus)),
  wardId: Type.Optional(Id),
  cursor: Cursor,
  limit: Limit,
});

export const OPERATIONS_SCHEMAS = [
  ShiftKind,
  ShiftStatus,
  RosterShift,
  RosterShiftPage,
  RosterShiftCreate,
  BloodGroup,
  BloodComponent,
  BloodUnitStatus,
  BloodUnit,
  BloodUnitPage,
  BloodUnitEntry,
  BloodUnitDetail,
  BloodUnitCreate,
  BloodUnitMove,
  BloodStockRow,
  BloodStock,
  AmbulanceKind,
  AmbulanceStatus,
  Ambulance,
  AmbulancePage,
  AmbulanceCreate,
  AmbulanceServiceChange,
  TripStatus,
  AmbulanceTrip,
  AmbulanceTripPage,
  AmbulanceTripCreate,
  AmbulanceTripMove,
  CleaningKind,
  CleaningStatus,
  CleaningTask,
  CleaningTaskPage,
  CleaningTaskCreate,
  CleaningTaskMove,
] as const;
