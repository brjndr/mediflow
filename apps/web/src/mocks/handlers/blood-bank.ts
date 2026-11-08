import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';

type Unit = components['schemas']['BloodUnit'];
type Status = Unit['status'];
type Entry = components['schemas']['BloodUnitEntry'];
type StockRow = components['schemas']['BloodStockRow'];

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
    version: 2,
  },
];

const seedHistory = (): Map<string, Entry[]> => {
  const entries = new Map<string, Entry[]>();
  for (const unit of seed()) {
    const at = unit.collectedAt;
    const list: Entry[] = [
      { toStatus: 'collected', actorId: 'user_1', occurredAt: at },
      { fromStatus: 'collected', toStatus: 'testing', actorId: 'user_1', occurredAt: at },
    ];
    if (unit.status === 'available') {
      list.push({
        fromStatus: 'testing',
        toStatus: 'available',
        actorId: 'user_1',
        occurredAt: at,
      });
    }
    entries.set(unit.id, list);
  }
  return entries;
};

let units = seed();
let history = seedHistory();
onMockReset(() => {
  units = seed();
  history = seedHistory();
});

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
    version: 1,
    ...unit,
  });
}

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
    history.set(unit.id, [
      ...(history.get(unit.id) ?? []),
      {
        fromStatus: from,
        toStatus: body.to,
        ...(unit.patientId ? { patientId: unit.patientId } : {}),
        ...(body.reason ? { reason: body.reason } : {}),
        actorId: 'user_1',
        occurredAt: new Date().toISOString(),
      },
    ]);
    return HttpResponse.json<Unit>(unit);
  }),
];
