import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { maskPhone } from '@/shared/utils/mask';
import { currentPolicy, onMockReset, TENANT_IDS } from '../db';
import { authorize, error, searchBody } from '../respond';
import { addCollectedMockUnits, mockDonorUnits } from './blood-bank';

type Donor = components['schemas']['BloodDonor'];
type Summary = components['schemas']['BloodDonorSummary'];
type Group = Donor['bloodGroup'];
type Sex = Donor['sex'];
type Collection = components['schemas']['BloodCollection'];
type Component = components['schemas']['BloodComponent'];

const FEATURE_FLAG = 'bloodbank';
const DAY_MS = 86_400_000;
const GROUPS: Group[] = ['O+', 'A+', 'B+', 'AB+', 'O-', 'A-', 'B-', 'AB-'];
const SEXES: Sex[] = ['female', 'male', 'other'];
const COMPONENTS: Component[] = ['whole_blood', 'red_cells', 'plasma', 'platelets', 'cryo'];

interface Row {
  tenantId: string;
  id: string;
  donorNumber: string;
  fullName: string;
  dateOfBirth: string;
  phone?: string;
  sex: Sex;
  bloodGroup: Group;
  deferredUntil?: string;
  deferredPermanent: boolean;
  deferralReason?: string;
  lastDonatedAt?: string;
  version: number;
}

const seed = (): Row[] => [
  {
    tenantId: TENANT_IDS.hospital,
    id: 'dn_1',
    donorNumber: 'DN-0001',
    fullName: 'Rohan Test-Donor',
    dateOfBirth: '1990-04-12',
    phone: '+919800000011',
    sex: 'male',
    bloodGroup: 'O+',
    deferredPermanent: false,
    lastDonatedAt: '2026-08-01T08:00:00.000Z',
    version: 1,
  },
  {
    tenantId: TENANT_IDS.hospital,
    id: 'dn_2',
    donorNumber: 'DN-0002',
    fullName: 'Sara Test-Donor',
    dateOfBirth: '1992-09-30',
    phone: '+919800000022',
    sex: 'female',
    bloodGroup: 'O+',
    deferredPermanent: false,
    lastDonatedAt: new Date(Date.now() - 10 * DAY_MS).toISOString(),
    version: 1,
  },
  {
    tenantId: TENANT_IDS.hospital,
    id: 'dn_3',
    donorNumber: 'DN-0003',
    fullName: 'Imran Test-Donor',
    dateOfBirth: '1985-01-20',
    sex: 'male',
    bloodGroup: 'A+',
    deferredPermanent: true,
    deferralReason: 'Reactive screening',
    version: 2,
  },
  {
    tenantId: TENANT_IDS.clinic,
    id: 'dc_1',
    donorNumber: 'DN-0001',
    fullName: 'Clinic Only-Donor',
    dateOfBirth: '1988-06-06',
    sex: 'female',
    bloodGroup: 'B-',
    deferredPermanent: false,
    version: 1,
  },
];

let rows = seed();
/** Volume and time of donations recorded in this session; seeded ones are worked out from units. */
let recorded = new Map<string, { volumeMl: number; collectedAt: string }>();
onMockReset(() => {
  rows = seed();
  recorded = new Map();
});

const hasPermission = (permission: string) =>
  currentPolicy()?.permissions.some((grant) => grant.permission === permission) === true;

const deferredNow = (row: Row, now = Date.now()) =>
  row.deferredPermanent ||
  (row.deferredUntil !== undefined && new Date(row.deferredUntil).getTime() > now);

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}.`)
    .join(' ');

const summary = (row: Row): Summary => ({
  id: row.id,
  tenantId: row.tenantId,
  donorNumber: row.donorNumber,
  sex: row.sex,
  bloodGroup: row.bloodGroup,
  status: deferredNow(row) ? 'deferred' : 'active',
  ...(row.deferredUntil ? { deferredUntil: row.deferredUntil } : {}),
  deferredPermanent: row.deferredPermanent,
  ...(row.lastDonatedAt ? { lastDonatedAt: row.lastDonatedAt } : {}),
  version: row.version,
  maskedName: initials(row.fullName),
  ...(row.phone ? { maskedPhone: maskPhone(row.phone) } : {}),
});

function collectionsOf(row: Row): Collection[] {
  const byCollection = new Map<string, Collection>();
  for (const { unit, collectionId } of mockDonorUnits(row.tenantId, row.id)) {
    const known = byCollection.get(collectionId);
    if (known) {
      known.unitIds.push(unit.id);
      continue;
    }
    const own = recorded.get(collectionId);
    byCollection.set(collectionId, {
      id: collectionId,
      donorId: row.id,
      collectedAt: own?.collectedAt ?? unit.collectedAt,
      volumeMl: own?.volumeMl ?? unit.volumeMl,
      unitIds: [unit.id],
    });
  }
  return [...byCollection.values()].sort((a, b) => b.collectedAt.localeCompare(a.collectedAt));
}

const full = (row: Row): Donor => ({
  ...summary(row),
  fullName: row.fullName,
  dateOfBirth: row.dateOfBirth,
  ...(row.phone ? { phone: row.phone } : {}),
  ...(row.deferralReason ? { deferralReason: row.deferralReason } : {}),
  collections: collectionsOf(row),
});

/** Whole years on a day; the donor must be 18 to 65. */
function age(dateOfBirth: string, on: Date): number {
  const [y = 0, m = 0, d = 0] = dateOfBirth.split('-').map(Number);
  const had = on.getUTCMonth() + 1 > m || (on.getUTCMonth() + 1 === m && on.getUTCDate() >= d);
  return on.getUTCFullYear() - y - (had ? 0 : 1);
}
const ageOk = (dateOfBirth: string, on: Date) => {
  const years = age(dateOfBirth, on);
  return years >= 18 && years <= 65;
};

export const bloodDonorHandlers = [
  http.post('*/api/blood/donors/search', async ({ request }) => {
    const access = authorize(request, { permission: 'bloodDonor:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const query = await searchBody(request);
    const q = (query.get('q') ?? '').trim().toLowerCase();
    const group = query.get('bloodGroup');
    const status = query.get('status');
    if (group !== null && !GROUPS.includes(group as Group)) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const limit = Math.min(Number(query.get('limit') ?? 25) || 25, 100);
    const cursor = query.get('cursor');
    const all = rows
      .filter((row) => row.tenantId === access.tenantId)
      .filter((row) => !group || row.bloodGroup === group)
      .filter((row) => !status || summary(row).status === status)
      .filter(
        (row) =>
          q === '' ||
          row.fullName.toLowerCase().includes(q) ||
          row.donorNumber.toLowerCase().includes(q),
      )
      .reverse();
    const start = cursor ? all.findIndex((row) => row.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    const next = all[start + limit];
    return HttpResponse.json({
      items: all.slice(start, start + limit).map(summary),
      nextCursor: next ? next.id : null,
      ...(cursor ? {} : { total: all.length }),
    });
  }),

  http.post('*/api/blood/donors', async ({ request }) => {
    const access = authorize(request, {
      permission: 'bloodDonor:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as Partial<Donor> | null;
    if (
      !body ||
      typeof body.fullName !== 'string' ||
      body.fullName.trim() === '' ||
      typeof body.dateOfBirth !== 'string' ||
      !SEXES.includes(body.sex as Sex) ||
      !GROUPS.includes(body.bloodGroup as Group)
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (!ageOk(body.dateOfBirth, new Date())) {
      return error(422, 'donor_age', 'A donor is 18 to 65 years old');
    }
    const count = rows.filter((row) => row.tenantId === access.tenantId).length;
    const row: Row = {
      tenantId: access.tenantId,
      id: `dn_${rows.length + 1}`,
      donorNumber: `DN-${String(count + 1).padStart(4, '0')}`,
      fullName: body.fullName,
      dateOfBirth: body.dateOfBirth,
      ...(body.phone ? { phone: body.phone } : {}),
      sex: body.sex as Sex,
      bloodGroup: body.bloodGroup as Group,
      deferredPermanent: false,
      version: 1,
    };
    rows.push(row);
    return HttpResponse.json<Donor>(full(row), { status: 201 });
  }),

  http.get('*/api/blood/donors/:donorId/trace', ({ request, params }) => {
    const access = authorize(request, { permission: 'bloodDonor:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    if (!hasPermission('transfusionReaction:read')) {
      return error(403, 'permission_denied', 'Missing transfusionReaction:read');
    }
    const row = rows.find((r) => r.id === params.donorId && r.tenantId === access.tenantId);
    if (!row) return error(404, 'blood_donor_not_found', 'No such donor');
    return HttpResponse.json({
      donor: {
        id: row.id,
        donorNumber: row.donorNumber,
        bloodGroup: row.bloodGroup,
        fullName: row.fullName,
      },
      units: mockDonorUnits(access.tenantId, row.id).map(
        ({ unit, collectionId, recipientPatientId }) => ({
          unit,
          collectionId,
          ...(recipientPatientId ? { recipientPatientId } : {}),
          reactionCount: 0,
        }),
      ),
    });
  }),

  http.get('*/api/blood/donors/:donorId', ({ request, params }) => {
    const access = authorize(request, { permission: 'bloodDonor:read', featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const row = rows.find((r) => r.id === params.donorId && r.tenantId === access.tenantId);
    if (!row) return error(404, 'blood_donor_not_found', 'No such donor');
    return HttpResponse.json<Donor>(full(row));
  }),

  http.patch('*/api/blood/donors/:donorId', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'bloodDonor:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const row = rows.find((r) => r.id === params.donorId && r.tenantId === access.tenantId);
    if (!row) return error(404, 'blood_donor_not_found', 'No such donor');
    const body = (await request.json().catch(() => null)) as {
      expectedVersion?: number;
      fullName?: string;
      dateOfBirth?: string;
      sex?: Sex;
      phone?: string | null;
    } | null;
    if (!body || typeof body.expectedVersion !== 'number') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (body.expectedVersion !== row.version) {
      return error(409, 'conflict', 'The donor has changed since it was read');
    }
    if (body.dateOfBirth !== undefined && !ageOk(body.dateOfBirth, new Date())) {
      return error(422, 'donor_age', 'A donor is 18 to 65 years old');
    }
    if (body.fullName !== undefined) row.fullName = body.fullName.trim();
    if (body.dateOfBirth !== undefined) row.dateOfBirth = body.dateOfBirth;
    if (body.sex !== undefined) row.sex = body.sex;
    if (body.phone === null) delete row.phone;
    else if (body.phone !== undefined) row.phone = body.phone;
    row.version += 1;
    return HttpResponse.json<Donor>(full(row));
  }),

  http.post('*/api/blood/donors/:donorId/defer', async ({ request, params }) => {
    const access = authorize(request, {
      permission: 'bloodDonor:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const row = rows.find((r) => r.id === params.donorId && r.tenantId === access.tenantId);
    if (!row) return error(404, 'blood_donor_not_found', 'No such donor');
    const body = (await request.json().catch(() => null)) as {
      reason?: string;
      until?: string;
    } | null;
    if (!body || typeof body.reason !== 'string' || body.reason.trim() === '') {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    if (row.deferredPermanent) return error(409, 'conflict', 'The deferral is final');
    if (body.until === undefined) {
      row.deferredPermanent = true;
      delete row.deferredUntil;
    } else {
      if (!(new Date(body.until).getTime() > Date.now())) {
        return error(422, 'invalid_period', 'The deferral must end in the future');
      }
      // Never shortened: a later date replaces an earlier one, not the other way round.
      if (!row.deferredUntil || row.deferredUntil < body.until) row.deferredUntil = body.until;
    }
    row.deferralReason = body.reason;
    row.version += 1;
    return HttpResponse.json<Donor>(full(row));
  }),

  http.post('*/api/blood/collections', async ({ request }) => {
    const access = authorize(request, {
      permission: 'bloodDonor:manage',
      featureFlag: FEATURE_FLAG,
    });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as {
      donorId?: string;
      collectedAt?: string;
      volumeMl?: number;
      units?: {
        unitNumber?: string;
        component?: Component;
        volumeMl?: number;
        expiresAt?: string;
      }[];
    } | null;
    if (
      !body ||
      typeof body.donorId !== 'string' ||
      typeof body.volumeMl !== 'number' ||
      !Array.isArray(body.units) ||
      body.units.length === 0 ||
      body.units.some(
        (unit) =>
          typeof unit.unitNumber !== 'string' ||
          !COMPONENTS.includes(unit.component as Component) ||
          typeof unit.volumeMl !== 'number' ||
          typeof unit.expiresAt !== 'string',
      )
    ) {
      return error(400, 'validation_failed', 'The request is not valid');
    }
    const row = rows.find((r) => r.id === body.donorId && r.tenantId === access.tenantId);
    if (!row) return error(404, 'blood_donor_not_found', 'No such donor');
    const collectedAt = body.collectedAt ?? new Date().toISOString();
    const at = new Date(collectedAt);
    if (deferredNow(row)) return error(422, 'donor_deferred', 'The donor is deferred');
    if (!ageOk(row.dateOfBirth, at)) {
      return error(422, 'donor_age', 'A donor is 18 to 65 years old');
    }
    if (row.lastDonatedAt && at.getTime() - new Date(row.lastDonatedAt).getTime() < 90 * DAY_MS) {
      return error(422, 'donation_too_soon', 'The donor gave blood less than 90 days ago');
    }
    if (
      at.getTime() > Date.now() + 60_000 ||
      body.units.some((unit) => !(new Date(unit.expiresAt as string).getTime() > at.getTime()))
    ) {
      return error(422, 'invalid_period', 'Check the dates');
    }
    const collectionId = `bc_${rows.length}_${recorded.size + 10}`;
    const made = addCollectedMockUnits(
      access.tenantId,
      body.units.map((unit) => ({
        unitNumber: unit.unitNumber as string,
        bloodGroup: row.bloodGroup,
        component: unit.component as Component,
        volumeMl: unit.volumeMl as number,
        collectedAt,
        expiresAt: unit.expiresAt as string,
      })),
      collectionId,
      {
        id: row.id,
        donorNumber: row.donorNumber,
        bloodGroup: row.bloodGroup,
        fullName: row.fullName,
      },
    );
    if (made.duplicate) return error(409, 'duplicate_unit', 'A unit with that number exists');
    recorded.set(collectionId, { volumeMl: body.volumeMl, collectedAt });
    row.lastDonatedAt = collectedAt;
    row.version += 1;
    return HttpResponse.json<Collection>(
      {
        id: collectionId,
        donorId: row.id,
        collectedAt,
        volumeMl: body.volumeMl,
        unitIds: made.ids,
      },
      { status: 201 },
    );
  }),
];
