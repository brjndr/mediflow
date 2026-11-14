import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { currentPolicy, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Unit = components['schemas']['BloodUnit'];
type Status = Unit['status'];
type Entry = components['schemas']['BloodUnitEntry'];
type StockRow = components['schemas']['BloodStockRow'];
type Screening = components['schemas']['BloodScreening'];
type Crossmatch = components['schemas']['BloodCrossmatch'];
type Reaction = components['schemas']['TransfusionReaction'];
type Group = Unit['bloodGroup'];
type Severity = Reaction['severity'];

const FEATURE_FLAG = 'bloodbank';

const MOVES: Record<Status, Status[]> = {
  collected: ['testing', 'discarded'],
  testing: ['available', 'discarded'],
  available: ['reserved', 'discarded', 'expired'],
  reserved: ['available', 'issued', 'discarded', 'expired'],
  issued: ['transfused', 'discarded'],
  transfused: [],
  discarded: [],
  expired: [],
};

const ISSUE_SIDE = new Set<Status>(['reserved', 'issued', 'transfused']);
const STATUSES = Object.keys(MOVES) as Status[];

const GROUPS: Group[] = ['O+', 'A+', 'B+', 'AB+', 'O-', 'A-', 'B-', 'AB-'];
const SEVERITIES: Severity[] = ['mild', 'moderate', 'severe'];
const KINDS = ['febrile', 'allergic', 'hemolytic', 'trali', 'taco', 'other'];
const CROSSMATCH_MS = 72 * 3_600_000;
const RESULTS = ['negative', 'reactive'];
const TESTS = ['hiv', 'hbv', 'hcv', 'syphilis', 'malaria'] as const;

const seed = (): Unit[] => [
  {
    id: 'bu_1',
    tenantId: TENANT_IDS.hospital,
    unitNumber: 'BU-0001',
    bloodGroup: 'O+',
    component: 'red_cells',
    volumeMl: 350,
    collectedAt: '2026-11-01T08:00:00.000Z',
    expiresAt: '2030-12-06T08:00:00.000Z',
    status: 'available',
    screeningStatus: 'cleared',
    version: 3,
  },
  {
    id: 'bu_2',
    tenantId: TENANT_IDS.hospital,
    unitNumber: 'BU-0002',
    bloodGroup: 'A-',
    component: 'platelets',
    volumeMl: 250,
    collectedAt: '2026-11-05T08:00:00.000Z',
    expiresAt: '2030-11-10T08:00:00.000Z',
    status: 'testing',
    screeningStatus: 'pending',
    version: 2,
  },
  // Given to the first sample patient; its collection has a reserved sibling (BU-0004).
  {
    id: 'bu_3',
    tenantId: TENANT_IDS.hospital,
    unitNumber: 'BU-0003',
    bloodGroup: 'O+',
    component: 'red_cells',
    volumeMl: 350,
    collectedAt: '2026-11-02T08:00:00.000Z',
    expiresAt: '2030-12-07T08:00:00.000Z',
    status: 'issued',
    screeningStatus: 'cleared',
    patientId: 'pth_00001',
    version: 6,
  },
  {
    id: 'bu_4',
    tenantId: TENANT_IDS.hospital,
    unitNumber: 'BU-0004',
    bloodGroup: 'O+',
    component: 'plasma',
    volumeMl: 200,
    collectedAt: '2026-11-02T08:00:00.000Z',
    expiresAt: '2030-12-08T08:00:00.000Z',
    status: 'reserved',
    screeningStatus: 'cleared',
    patientId: 'pth_00002',
    version: 5,
  },
];

const seedHistory = (): Map<string, Entry[]> => {
  const entries = new Map<string, Entry[]>();
  const forward: Status[] = ['available', 'reserved', 'issued'];
  for (const unit of seed()) {
    const at = unit.collectedAt;
    const list: Entry[] = [
      { toStatus: 'collected', actorId: 'user_1', occurredAt: at },
      { fromStatus: 'collected', toStatus: 'testing', actorId: 'user_1', occurredAt: at },
    ];
    const reached = forward.indexOf(unit.status);
    if (reached >= 0) {
      let from: Status = 'testing';
      for (const to of forward.slice(0, reached + 1)) {
        list.push({
          fromStatus: from,
          toStatus: to,
          ...(unit.patientId && to !== 'available' ? { patientId: unit.patientId } : {}),
          actorId: 'user_1',
          occurredAt: at,
        });
        from = to;
      }
    }
    entries.set(unit.id, list);
  }
  return entries;
};

export interface Donor {
  id: string;
  donorNumber: string;
  bloodGroup: Group;
  fullName: string;
}

const seedExtras = () => ({
  screenings: new Map<string, Screening>(
    ['bu_1', 'bu_3', 'bu_4'].map((unitId) => [
      unitId,
      {
        id: `bs_${unitId}`,
        unitId,
        hiv: 'negative',
        hbv: 'negative',
        hcv: 'negative',
        syphilis: 'negative',
        malaria: 'negative',
        outcome: 'cleared',
        screenedBy: 'user_1',
        screenedAt: '2026-11-02T08:00:00.000Z',
      } satisfies Screening,
    ]),
  ),
  crossmatches: [
    {
      id: 'cm_1',
      unitId: 'bu_3',
      patientId: 'pth_00001',
      result: 'compatible',
      performedBy: 'user_1',
      performedAt: '2026-11-03T08:00:00.000Z',
      validUntil: '2026-11-06T08:00:00.000Z',
    },
  ] as Crossmatch[],
  reactions: [] as (Reaction & { tenantId: string })[],
  collections: new Map<string, string>([
    ['bu_3', 'bc_1'],
    ['bu_4', 'bc_1'],
    ['bu_1', 'bc_2'],
  ]),
  donors: new Map<string, Donor>([
    [
      'bc_1',
      { id: 'dn_1', donorNumber: 'DN-0001', bloodGroup: 'O+', fullName: 'Rohan Test-Donor' },
    ],
    ['bc_2', { id: 'dn_2', donorNumber: 'DN-0002', bloodGroup: 'O+', fullName: 'Sara Test-Donor' }],
  ]),
});

type GroupEntry = components['schemas']['PatientBloodGroupEntry'];

let units = seed();
let history = seedHistory();
let extras = seedExtras();
/** Blood groups written on patients in this session, newest first. A missing patient has the default. */
let groupLog = new Map<string, GroupEntry[]>();
onMockReset(() => {
  units = seed();
  history = seedHistory();
  extras = seedExtras();
  groupLog = new Map();
});

/** For tests: a patient with no blood group on record. */
export function clearMockPatientBloodGroup(patientId: string): void {
  groupLog.set(patientId, []);
}

/** A donation makes units in `collected`, as the real API does. Returns the ids made. */
export function addCollectedMockUnits(
  tenantId: string,
  made: Pick<
    Unit,
    'unitNumber' | 'bloodGroup' | 'component' | 'volumeMl' | 'collectedAt' | 'expiresAt'
  >[],
  collectionId: string,
  donor: Donor,
): { ids: string[]; duplicate: boolean } {
  if (
    made.some((m) => units.some((u) => u.tenantId === tenantId && u.unitNumber === m.unitNumber))
  ) {
    return { ids: [], duplicate: true };
  }
  const ids = made.map((m) => {
    const unit: Unit = {
      ...m,
      id: `bu_${units.length + 1}`,
      tenantId,
      status: 'collected',
      screeningStatus: 'pending',
      version: 1,
    };
    units.push(unit);
    history.set(unit.id, [
      { toStatus: 'collected', actorId: 'user_1', occurredAt: new Date().toISOString() },
    ]);
    extras.collections.set(unit.id, collectionId);
    extras.donors.set(collectionId, donor);
    return unit.id;
  });
  return { ids, duplicate: false };
}

/** For tests: a unit the bank holds. */
export function addMockBloodUnit(unit: Partial<Unit> & { id: string }): void {
  units.push({
    tenantId: TENANT_IDS.hospital,
    unitNumber: unit.id.toUpperCase(),
    bloodGroup: 'B+',
    component: 'plasma',
    volumeMl: 200,
    collectedAt: '2026-11-02T08:00:00.000Z',
    expiresAt: '2030-12-02T08:00:00.000Z',
    status: 'available',
    screeningStatus: 'cleared',
    version: 1,
    ...unit,
  });
}

/** Mock only: the group of a synthetic patient follows its number, so tests know it. */
function groupOf(patientId: string): Group {
  const written = groupLog.get(patientId)?.[0]?.bloodGroup;
  if (written) return written;
  const number = Number(patientId.slice(patientId.lastIndexOf('_') + 1));
  return GROUPS[(Number.isFinite(number) ? number - 1 : 0) % GROUPS.length] ?? 'O+';
}

/** The group on record and the entries before it, newest first. */
function groupRecord(patientId: string) {
  const logged = groupLog.get(patientId);
  const history: GroupEntry[] = logged ?? [
    {
      bloodGroup: groupOf(patientId),
      recordedBy: 'user_1',
      recordedAt: '2026-10-01T08:00:00.000Z',
    },
  ];
  const bloodGroup = history[0]?.bloodGroup;
  return { patientId, ...(bloodGroup ? { bloodGroup } : {}), history };
}

const abo = (group: Group) => group.slice(0, -1);
const positive = (group: Group) => group.endsWith('+');

/** A simple ABO and Rh rule for the mock; the real rule is the server's. */
function fits(unit: Pick<Unit, 'bloodGroup' | 'component'>, patient: Group): boolean {
  const donor = abo(unit.bloodGroup);
  const recipient = abo(patient);
  if (unit.component === 'red_cells' || unit.component === 'whole_blood') {
    const aboOk = donor === 'O' || donor === recipient;
    return aboOk && (!positive(unit.bloodGroup) || positive(patient));
  }
  // Plasma, platelets, cryo: the donor's antibodies must not meet the recipient's cells.
  return donor === 'AB' || donor === recipient || recipient === 'O';
}

const patientPrefix = (tenantId: string) => (tenantId === TENANT_IDS.hospital ? 'pth_' : 'ptc_');
const knownPatient = (tenantId: string, id: unknown): id is string =>
  typeof id === 'string' && id.startsWith(patientPrefix(tenantId));

const hasPermission = (permission: string) =>
  currentPolicy()?.permissions.some((grant) => grant.permission === permission) === true;

function pushHistory(unit: Unit, from: Status, reason?: string) {
  history.set(unit.id, [
    ...(history.get(unit.id) ?? []),
    {
      fromStatus: from,
      toStatus: unit.status,
      ...(unit.patientId ? { patientId: unit.patientId } : {}),
      ...(reason ? { reason } : {}),
      actorId: 'user_1',
      occurredAt: new Date().toISOString(),
    },
  ]);
}

/** A severe or hemolytic reaction holds the other units of the same collection. */
function holdSiblings(unit: Unit, tenantId: string): string[] {
  const collection = extras.collections.get(unit.id);
  if (!collection) return [];
  const held: string[] = [];
  for (const other of units) {
    if (other.id === unit.id || other.tenantId !== tenantId) continue;
    if (extras.collections.get(other.id) !== collection) continue;
    if (!['collected', 'testing', 'available', 'reserved', 'issued'].includes(other.status)) {
      continue;
    }
    const from = other.status;
    other.status = 'discarded';
    other.version += 1;
    pushHistory(other, from, 'Held after a transfusion reaction');
    held.push(other.id);
  }
  return held;
}

const latestCrossmatch = (unitId: string, patientId: string) =>
  extras.crossmatches
    .filter((match) => match.unitId === unitId && match.patientId === patientId)
    .sort((a, b) => b.performedAt.localeCompare(a.performedAt))[0];

const stillValid = (match: Crossmatch | undefined) =>
  match !== undefined &&
  match.result === 'compatible' &&
  new Date(match.validUntil).getTime() > Date.now();

export const bloodBankHandlers = [
  http.get('*/api/blood-units/stock', ({ request }) => {
    const access = authorize(request, { permission: 'bloodUnit:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const now = Date.now();
    const groups = new Map<string, StockRow>();
    for (const unit of units) {
      if (unit.tenantId !== access.tenantId) continue;
      if (unit.status !== 'available' && unit.status !== 'reserved') continue;
      if (new Date(unit.expiresAt).getTime() <= now) continue;
      const key = `${unit.bloodGroup}|${unit.component}`;
      const row = groups.get(key) ?? {
        bloodGroup: unit.bloodGroup,
        component: unit.component,
        available: 0,
        reserved: 0,
      };
      if (unit.status === 'available') row.available += 1;
      else row.reserved += 1;
      if (!row.nextExpiry || unit.expiresAt < row.nextExpiry) row.nextExpiry = unit.expiresAt;
      groups.set(key, row);
    }
    return HttpResponse.json({ items: [...groups.values()] });
  }),

  http.get('*/api/blood-units', ({ request }) => {
    const access = authorize(request, { permission: 'bloodUnit:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = new URL(request.url).searchParams;
    const status = query.get('status');
    if (status !== null && !STATUSES.includes(status as Status)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const group = query.get('bloodGroup');
    const component = query.get('component');
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const all = units
      .filter(
        (unit) =>
          unit.tenantId === access.tenantId &&
          (!status || unit.status === status) &&
          (!group || unit.bloodGroup === group) &&
          (!component || unit.component === component),
      )
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt));
    const start = cursor ? all.findIndex((unit) => unit.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    return HttpResponse.json({
      items: all.slice(start, start + limit),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: all.length }),
    });
  }),

  http.post('*/api/blood-units', async ({ request }) => {
    const access = authorize(request, {
      permission: 'bloodUnit:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as Partial<Unit> | null;
    if (!body || typeof body.unitNumber !== 'string' || !body.collectedAt || !body.expiresAt) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (!(new Date(body.expiresAt) > new Date(body.collectedAt))) {
      return error(422, 'invalid_period', 'A unit expires after it is collected');
    }
    if (units.some((u) => u.tenantId === access.tenantId && u.unitNumber === body.unitNumber)) {
      return error(409, 'duplicate_unit', 'A unit with that number exists');
    }
    const unit: Unit = {
      id: `bu_${units.length + 1}`,
      tenantId: access.tenantId,
      unitNumber: body.unitNumber,
      bloodGroup: body.bloodGroup ?? 'O+',
      component: body.component ?? 'red_cells',
      volumeMl: body.volumeMl ?? 350,
      collectedAt: body.collectedAt,
      expiresAt: body.expiresAt,
      status: 'collected',
      screeningStatus: 'pending',
      version: 1,
    };
    units.push(unit);
    history.set(unit.id, [
      { toStatus: 'collected', actorId: 'user_1', occurredAt: new Date().toISOString() },
    ]);
    return HttpResponse.json<Unit>(unit, { status: 201 });
  }),

  http.get('*/api/blood-units/:unitId', ({ request, params }) => {
    const access = authorize(request, { permission: 'bloodUnit:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const unit = units.find((u) => u.id === params.unitId && u.tenantId === access.tenantId);
    if (!unit) return error(404, 'blood_unit_not_found', 'No such blood unit');
    return HttpResponse.json({ unit, history: history.get(unit.id) ?? [] });
  }),

  http.post('*/api/blood-units/:unitId/move', async ({ request, params }) => {
    const access = authorize(request, { permission: 'bloodUnit:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      to?: Status;
      version?: number;
      patientId?: string;
      reason?: string;
    } | null;
    if (!body || !body.to || !STATUSES.includes(body.to) || typeof body.version !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const unit = units.find((u) => u.id === params.unitId && u.tenantId === access.tenantId);
    if (!unit) return error(404, 'blood_unit_not_found', 'No such blood unit');
    if (unit.version !== body.version) return error(409, 'conflict', 'It has changed');
    if (!MOVES[unit.status].includes(body.to)) {
      return error(409, 'invalid_transition', 'That move is not allowed');
    }
    // The ward's side (reserve, issue, transfuse, release) and the bank's are different grants.
    const needed =
      ISSUE_SIDE.has(body.to) || (unit.status === 'reserved' && body.to === 'available')
        ? 'bloodUnit:issue'
        : 'bloodUnit:manage';
    const grant = authorize(request, { permission: needed, featureFlag: FEATURE_FLAG });
    if ('denied' in grant) return error(403, 'permission_denied', `Missing ${needed}`);
    if (body.to === 'discarded' && !body.reason) {
      return error(422, 'reason_required', 'Say why the unit is discarded');
    }
    if (body.to === 'reserved' && !body.patientId) {
      return error(422, 'patient_required', 'Say which patient the unit is for');
    }
    if (
      unit.status === 'testing' &&
      body.to === 'available' &&
      unit.screeningStatus !== 'cleared'
    ) {
      return error(409, 'screening_required', 'The unit has not been screened clear');
    }
    if (body.to === 'reserved' && !stillValid(latestCrossmatch(unit.id, body.patientId ?? ''))) {
      return error(409, 'crossmatch_required', 'A compatible cross-match is needed');
    }
    const past = new Date(unit.expiresAt).getTime() <= Date.now();
    if (body.to === 'expired' && !past) return error(409, 'not_expired', 'Within its date');
    if ((body.to === 'reserved' || body.to === 'issued') && past) {
      return error(409, 'unit_expired', 'The unit is past its date');
    }
    const from = unit.status;
    unit.status = body.to;
    unit.version += 1;
    if (body.to === 'reserved' && body.patientId) unit.patientId = body.patientId;
    if (body.to === 'available') delete unit.patientId;
    pushHistory(unit, from, body.reason);
    return HttpResponse.json<Unit>(unit);
  }),

  http.post('*/api/blood-units/:unitId/screening', async ({ request, params }) => {
    const access = authorize(request, { permission: 'bloodUnit:test', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as Record<string, string> | null;
    if (!body || !TESTS.every((test) => RESULTS.includes(body[test] ?? ''))) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const unit = units.find((u) => u.id === params.unitId && u.tenantId === access.tenantId);
    if (!unit) return error(404, 'blood_unit_not_found', 'No such blood unit');
    if (unit.status !== 'testing') {
      return error(409, 'not_in_testing', 'The unit is not in testing');
    }
    if (extras.screenings.has(unit.id)) {
      return error(409, 'already_screened', 'The unit has been screened');
    }
    const reactive = TESTS.some((test) => body[test] === 'reactive');
    const screening: Screening = {
      id: `bs_${unit.id}`,
      unitId: unit.id,
      hiv: body.hiv as Screening['hiv'],
      hbv: body.hbv as Screening['hbv'],
      hcv: body.hcv as Screening['hcv'],
      syphilis: body.syphilis as Screening['syphilis'],
      malaria: body.malaria as Screening['malaria'],
      outcome: reactive ? 'reactive' : 'cleared',
      screenedBy: 'user_1',
      screenedAt: new Date().toISOString(),
    };
    extras.screenings.set(unit.id, screening);
    unit.screeningStatus = screening.outcome;
    unit.version += 1;
    if (reactive) {
      // Discarded in the same step; the donor is deferred for good (donors are not mocked here).
      unit.status = 'discarded';
      pushHistory(unit, 'testing', 'Reactive screening');
    }
    return HttpResponse.json<Screening>(screening, { status: 201 });
  }),

  http.post('*/api/blood-units/:unitId/crossmatch', async ({ request, params }) => {
    const access = authorize(request, { permission: 'bloodUnit:test', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      patientId?: string;
      result?: string;
    } | null;
    if (!body || (body.result !== 'compatible' && body.result !== 'incompatible')) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const unit = units.find((u) => u.id === params.unitId && u.tenantId === access.tenantId);
    if (!unit) return error(404, 'blood_unit_not_found', 'No such blood unit');
    if (!knownPatient(access.tenantId, body.patientId)) {
      return error(422, 'unknown_patient', 'No such patient');
    }
    if (unit.status !== 'available') return error(409, 'not_available', 'Not available');
    if (new Date(unit.expiresAt).getTime() <= Date.now()) {
      return error(409, 'unit_expired', 'The unit is past its date');
    }
    if (body.result === 'compatible' && !fits(unit, groupOf(body.patientId))) {
      return error(422, 'abo_incompatible', 'The blood groups can never match');
    }
    const now = Date.now();
    const match: Crossmatch = {
      id: `cm_${extras.crossmatches.length + 1}`,
      unitId: unit.id,
      patientId: body.patientId,
      result: body.result,
      performedBy: 'user_1',
      performedAt: new Date(now).toISOString(),
      validUntil: new Date(now + CROSSMATCH_MS).toISOString(),
    };
    extras.crossmatches.push(match);
    return HttpResponse.json<Crossmatch>(match, { status: 201 });
  }),

  http.post('*/api/blood/compatible-units', async ({ request }) => {
    const access = authorize(request, { permission: 'bloodUnit:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      patientId?: string;
      component?: string;
    } | null;
    if (!body || typeof body.component !== 'string') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (!knownPatient(access.tenantId, body.patientId)) {
      return error(422, 'unknown_patient', 'No such patient');
    }
    const patientId = body.patientId;
    const patientBloodGroup = groupOf(patientId);
    const items = units
      .filter(
        (unit) =>
          unit.tenantId === access.tenantId &&
          unit.status === 'available' &&
          unit.component === body.component &&
          new Date(unit.expiresAt).getTime() > Date.now() &&
          fits(unit, patientBloodGroup),
      )
      .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))
      .map((unit) => {
        const crossmatch = latestCrossmatch(unit.id, patientId);
        return {
          unit,
          ...(crossmatch ? { crossmatch } : {}),
          crossmatchValid: stillValid(crossmatch),
        };
      });
    return HttpResponse.json({ patientBloodGroup, items });
  }),

  http.get('*/api/patients/:patientId/blood-group', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'patient.bloodGroup:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    if (!knownPatient(access.tenantId, patientId)) {
      return error(404, 'patient_not_found', 'No such patient');
    }
    return HttpResponse.json(groupRecord(patientId));
  }),

  http.post('*/api/patients/:patientId/blood-group', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'patient.bloodGroup:update',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const patientId = String(params.patientId);
    if (!knownPatient(access.tenantId, patientId)) {
      return error(422, 'unknown_patient', 'No such patient');
    }
    const body = (await request.json().catch(() => null)) as {
      bloodGroup?: Group;
      reason?: string;
    } | null;
    if (!body?.bloodGroup || !GROUPS.includes(body.bloodGroup)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const current = groupRecord(patientId).bloodGroup;
    if (current === body.bloodGroup) return HttpResponse.json(groupRecord(patientId));
    if (current !== undefined && !body.reason?.trim()) {
      return error(422, 'reason_required', 'A reason is needed to change the group');
    }
    const earlier = groupRecord(patientId).history;
    groupLog.set(patientId, [
      {
        bloodGroup: body.bloodGroup,
        ...(body.reason ? { reason: body.reason } : {}),
        recordedBy: 'user_1',
        recordedAt: new Date().toISOString(),
      },
      ...earlier,
    ]);
    return HttpResponse.json(groupRecord(patientId));
  }),

  http.post('*/api/transfusion-reactions', async ({ request }) => {
    const access = authorize(request, {
      permission: 'transfusionReaction:record',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    if (request.headers.get('idempotency-key') === null) {
      return error(400, 'idempotency_key_required', 'An Idempotency-Key is required');
    }
    const body = (await request.json().catch(() => null)) as Partial<Reaction> | null;
    if (
      !body ||
      typeof body.unitId !== 'string' ||
      typeof body.patientId !== 'string' ||
      !KINDS.includes(body.kind ?? '') ||
      !SEVERITIES.includes(body.severity as Severity) ||
      !body.transfusedAt ||
      !body.onsetAt ||
      !body.actions
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const unit = units.find((u) => u.id === body.unitId && u.tenantId === access.tenantId);
    if (!unit) return error(404, 'blood_unit_not_found', 'No such blood unit');
    if (unit.status !== 'issued' && unit.status !== 'transfused') {
      return error(409, 'unit_not_given', 'The unit was not given');
    }
    if (unit.patientId !== body.patientId) {
      return error(422, 'patient_mismatch', 'The unit went to another patient');
    }
    if (new Date(body.onsetAt) < new Date(body.transfusedAt)) {
      return error(422, 'invalid_period', 'The reaction began before the transfusion');
    }
    const reaction: Reaction & { tenantId: string } = {
      id: `tr_${extras.reactions.length + 1}`,
      tenantId: access.tenantId,
      unitId: unit.id,
      patientId: body.patientId,
      transfusedAt: body.transfusedAt,
      onsetAt: body.onsetAt,
      kind: body.kind as Reaction['kind'],
      severity: body.severity as Severity,
      currentSeverity: body.severity as Severity,
      actions: body.actions,
      reportedBy: 'user_1',
      createdAt: new Date().toISOString(),
      updates: [],
    };
    extras.reactions.push(reaction);
    const held =
      reaction.severity === 'severe' || reaction.kind === 'hemolytic'
        ? holdSiblings(unit, access.tenantId)
        : [];
    const { tenantId: _tenantId, ...shown } = reaction;
    return HttpResponse.json<Reaction>({ ...shown, heldUnitIds: held }, { status: 201 });
  }),

  http.post('*/api/transfusion-reactions/:reactionId/updates', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'transfusionReaction:record',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      note?: string;
      severity?: Severity;
    } | null;
    if (!body || !body.note || (body.severity && !SEVERITIES.includes(body.severity))) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const reaction = extras.reactions.find(
      (r) => r.id === params.reactionId && r.tenantId === access.tenantId,
    );
    if (!reaction) return error(404, 'reaction_not_found', 'No such reaction');
    if (
      body.severity &&
      SEVERITIES.indexOf(body.severity) <= SEVERITIES.indexOf(reaction.currentSeverity)
    ) {
      return error(422, 'severity_not_raised', 'A severity can only be raised');
    }
    reaction.updates.push({
      id: `tu_${reaction.updates.length + 1}`,
      note: body.note,
      ...(body.severity ? { severity: body.severity } : {}),
      recordedBy: 'user_1',
      recordedAt: new Date().toISOString(),
    });
    let held: string[] = [];
    if (body.severity) {
      reaction.currentSeverity = body.severity;
      const unit = units.find((u) => u.id === reaction.unitId);
      if (body.severity === 'severe' && unit) held = holdSiblings(unit, access.tenantId);
    }
    const { tenantId: _tenantId, ...shown } = reaction;
    return HttpResponse.json<Reaction>({ ...shown, heldUnitIds: held }, { status: 201 });
  }),

  http.get('*/api/blood-units/:unitId/trace', ({ request, params }) => {
    const access = authorize(request, {
      permission: 'transfusionReaction:read',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const unit = units.find((u) => u.id === params.unitId && u.tenantId === access.tenantId);
    if (!unit) return error(404, 'blood_unit_not_found', 'No such blood unit');
    const entries = history.get(unit.id) ?? [];
    const collection = extras.collections.get(unit.id);
    const donor = collection ? extras.donors.get(collection) : undefined;
    const screening = extras.screenings.get(unit.id);
    const recipient = [...entries].reverse().find((entry) => entry.toStatus === 'issued');
    return HttpResponse.json({
      unit,
      ...(donor
        ? {
            donor: {
              id: donor.id,
              donorNumber: donor.donorNumber,
              bloodGroup: donor.bloodGroup,
              // The name goes only to a caller who may read donors.
              ...(hasPermission('bloodDonor:read') ? { fullName: donor.fullName } : {}),
            },
          }
        : {}),
      ...(collection ? { collectionId: collection, collectedAt: unit.collectedAt } : {}),
      ...(screening ? { screeningOutcome: screening.outcome } : {}),
      history: entries,
      crossmatches: extras.crossmatches
        .filter((match) => match.unitId === unit.id)
        .sort((a, b) => b.performedAt.localeCompare(a.performedAt)),
      ...(recipient?.patientId ? { recipientPatientId: recipient.patientId } : {}),
      reactions: extras.reactions
        .filter((reaction) => reaction.unitId === unit.id && reaction.tenantId === access.tenantId)
        .map(({ tenantId: _tenantId, ...shown }) => shown),
    });
  }),
];

/** The units made from a donor's donations, with the collection each came from. */
export function mockDonorUnits(
  tenantId: string,
  donorId: string,
): { unit: Unit; collectionId: string; recipientPatientId?: string }[] {
  return units
    .filter((unit) => unit.tenantId === tenantId)
    .flatMap((unit) => {
      const collectionId = extras.collections.get(unit.id);
      if (!collectionId || extras.donors.get(collectionId)?.id !== donorId) return [];
      const recipient = [...(history.get(unit.id) ?? [])]
        .reverse()
        .find((entry) => entry.toStatus === 'issued');
      return [
        {
          unit,
          collectionId,
          ...(recipient?.patientId ? { recipientPatientId: recipient.patientId } : {}),
        },
      ];
    });
}
