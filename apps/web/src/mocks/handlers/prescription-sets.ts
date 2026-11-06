import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { PLAIN_LINES, PLAIN_TEXT } from '@/shared/utils/text';
import { currentPolicy, currentSession, onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDrug, mockDrugsOf } from './drugs';

type Schemas = components['schemas'];
type PrescriptionSet = Schemas['PrescriptionSet'];
type SetDetail = Schemas['PrescriptionSetDetail'];
type SetLine = Schemas['PrescriptionSetLine'];
type FavouriteDrugs = Schemas['FavouriteDrugs'];

const FEATURE_FLAG = 'clinical';
const READ = 'prescriptionSet:read';
const MANAGE = 'prescriptionSet:manage';
const SHARED = 'prescriptionSet:manageShared';
const ROUTES = [
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
];
const LINES_MAX = 30;
const FAVOURITES_MAX = 20;

interface Stored {
  id: string;
  tenantId: string;
  name: string;
  /** The member of staff it belongs to; null: shared with the hospital. */
  ownerId: string | null;
  archived: boolean;
  version: number;
  updatedAt: string;
  lines: SetLine[];
}
interface State {
  sets: Stored[];
  created: number;
  /** Favourite medicines by hospital and member of staff. */
  favourites: Map<string, string[]>;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, { raw: string; id: string }>;
  seeded: boolean;
}

const fresh = (): State => ({
  sets: [],
  created: 0,
  favourites: new Map(),
  replies: new Map(),
  seeded: false,
});
let state = fresh();
onMockReset(() => {
  state = fresh();
});

/** The hospital's shared sets, made from the drugs mock the first time they are asked for. */
function seed() {
  if (state.seeded) return;
  state.seeded = true;
  const drug = (generic: string) =>
    mockDrugsOf(TENANT_IDS.hospital).find(
      (candidate) => candidate.type === 'medicine' && candidate.genericName === generic,
    );
  const paracetamol = drug('Paracetamol');
  const cetirizine = drug('Cetirizine');
  if (!paracetamol || !cetirizine) return;
  state.sets.push({
    id: 'pset_h_1',
    tenantId: TENANT_IDS.hospital,
    name: 'Common cold',
    ownerId: null,
    archived: false,
    version: 1,
    updatedAt: '2026-10-01T09:00:00.000Z',
    lines: [
      {
        drugId: paracetamol.id,
        dose: '500 mg',
        route: 'oral',
        frequency: '1-1-1',
        durationDays: 3,
        quantity: 9,
      },
      {
        drugId: cetirizine.id,
        dose: '10 mg',
        route: 'oral',
        frequency: '0-0-1',
        durationDays: 5,
        instructions: 'At night',
      },
    ],
  });
}

const userId = () => currentSession()?.user.id ?? '';
const mayShare = () =>
  currentPolicy()?.permissions.some((grant) => grant.permission === SHARED) ?? false;

const notFound = () => error(404, 'prescription_set_not_found', 'No such prescription set');
const invalid = () => error(400, 'validation_failed', 'The request is not valid');

/** The sets this member of staff may see: the hospital's shared ones and their own. */
const visible = (tenantId: string) =>
  state.sets.filter(
    (set) => set.tenantId === tenantId && (set.ownerId === null || set.ownerId === userId()),
  );
const find = (tenantId: string, id: string) => visible(tenantId).find((set) => set.id === id);

const summary = (set: Stored): PrescriptionSet => ({
  id: set.id,
  tenantId: set.tenantId,
  name: set.name,
  shared: set.ownerId === null,
  lineCount: set.lines.length,
  archived: set.archived,
  version: set.version,
  updatedAt: set.updatedAt,
});

const collator = new Intl.Collator('en');

function detail(set: Stored): SetDetail {
  return {
    set: summary(set),
    lines: set.lines.map((line) => {
      const drug = mockDrug(set.tenantId, line.drugId);
      return {
        ...line,
        drugName: drug
          ? [drug.genericName, drug.strength].filter(Boolean).join(' ') +
            (drug.brandName ? ` (${drug.brandName})` : '')
          : '',
        genericName: drug?.genericName ?? '',
        ...(drug?.brandName ? { brandName: drug.brandName } : {}),
        drugArchived: drug?.archived ?? true,
      };
    }),
  };
}

const text = (value: unknown, max: number, lines = false): string | null => {
  if (typeof value !== 'string') return null;
  const tidied = lines ? value.trim() : value.replace(/\s+/g, ' ').trim();
  return tidied.length >= 1 &&
    tidied.length <= max &&
    (lines ? PLAIN_LINES : PLAIN_TEXT).test(tidied)
    ? tidied
    : null;
};

/** The lines of a request, checked as the API checks them; null when one is not valid. */
function readLines(tenantId: string, value: unknown): SetLine[] | 'unknown_drug' | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > LINES_MAX) return null;
  const lines: SetLine[] = [];
  for (const each of value as Record<string, unknown>[]) {
    const dose = text(each?.dose, 50);
    const frequency = text(each?.frequency, 50);
    const route =
      typeof each?.route === 'string' && ROUTES.includes(each.route) ? each.route : null;
    if (!dose || !frequency || !route || typeof each?.drugId !== 'string') return null;
    const days = each.durationDays;
    const quantity = each.quantity;
    if (
      days !== undefined &&
      (!Number.isInteger(days) || (days as number) < 1 || (days as number) > 365)
    ) {
      return null;
    }
    if (
      quantity !== undefined &&
      (!Number.isInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 10000)
    ) {
      return null;
    }
    const instructions =
      each.instructions === undefined ? undefined : text(each.instructions, 500, true);
    if (instructions === null) return null;
    const drug = mockDrug(tenantId, each.drugId);
    if (!drug || drug.type !== 'medicine' || drug.archived) return 'unknown_drug';
    lines.push({
      drugId: drug.id,
      dose,
      route: route as SetLine['route'],
      frequency,
      ...(days === undefined ? {} : { durationDays: days as number }),
      ...(quantity === undefined ? {} : { quantity: quantity as number }),
      ...(instructions === undefined ? {} : { instructions }),
    });
  }
  return lines;
}

const nameTaken = (tenantId: string, name: string, ownerId: string | null, exceptId?: string) =>
  state.sets.some(
    (set) =>
      set.tenantId === tenantId &&
      set.ownerId === ownerId &&
      set.id !== exceptId &&
      set.name.toLowerCase() === name.toLowerCase(),
  );

const taken = () =>
  error(409, 'prescription_set_name_taken', 'A set of yours or a shared one has that name');

function favouritesOf(tenantId: string): FavouriteDrugs {
  const ids = state.favourites.get(`${tenantId}:${userId()}`) ?? [];
  return {
    items: ids.map((drugId) => {
      const drug = mockDrug(tenantId, drugId);
      return {
        drugId,
        name: drug
          ? [drug.genericName, drug.strength].filter(Boolean).join(' ') +
            (drug.brandName ? ` (${drug.brandName})` : '')
          : '',
        archived: drug?.archived ?? true,
      };
    }),
  };
}

/** What another member of staff does meanwhile: archives a medicine a set or a star names. */
export const mockSetsOf = (tenantId: string): PrescriptionSet[] => (
  seed(),
  state.sets.filter((set) => set.tenantId === tenantId).map(summary)
);

/** Adds a set the way a colleague would, for a test. */
export function addMockSet(set: {
  tenantId: string;
  name: string;
  ownerId: string | null;
  lines: SetLine[];
}): string {
  seed();
  state.created += 1;
  const id = `pset_new_${state.created}`;
  state.sets.push({
    id,
    archived: false,
    version: 1,
    updatedAt: new Date().toISOString(),
    ...set,
  });
  return id;
}

/** Puts medicines among a member of staff's favourites, for a test. */
export function setMockFavourites(tenantId: string, forUser: string, drugIds: string[]): void {
  state.favourites.set(`${tenantId}:${forUser}`, drugIds);
}

export const prescriptionSetsHandlers = [
  http.get('*/api/prescription-sets', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    seed();
    const params = new URL(request.url).searchParams;
    const archived = params.get('archived') === 'true';
    const items = visible(access.tenantId)
      .filter((set) => set.archived === archived)
      .map(summary)
      .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
    const limit = Math.min(Math.max(Number(params.get('limit')) || 25, 1), 100);
    const cursor = params.get('cursor');
    const start = cursor ? items.findIndex((set) => set.id === cursor) : 0;
    if (start < 0) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json({
      items: items.slice(start, start + limit),
      nextCursor: items[start + limit]?.id ?? null,
      ...(cursor ? {} : { total: items.length }),
    });
  }),

  http.post('*/api/prescription-sets', async ({ request }) => {
    const manage = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in manage) return manage.denied;
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    seed();
    const raw = await request.clone().text();
    const key = request.headers.get('idempotency-key');
    const earlier = key ? state.replies.get(`${access.tenantId}:${key}`) : undefined;
    if (earlier) {
      const set = find(access.tenantId, earlier.id);
      return earlier.raw === raw && set
        ? HttpResponse.json<SetDetail>(detail(set), {
            status: 201,
            headers: { 'Idempotent-Replayed': 'true' },
          })
        : error(422, 'idempotency_key_reuse', 'That key was used for another request');
    }
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const name = text(body?.name, 100);
    const lines = readLines(access.tenantId, body?.lines);
    if (
      !name ||
      lines === null ||
      (body?.shared !== undefined && typeof body.shared !== 'boolean')
    ) {
      return invalid();
    }
    if (body?.shared === true && !mayShare()) {
      return error(403, 'permission_denied', 'Sharing a set needs more access');
    }
    if (lines === 'unknown_drug') return error(422, 'unknown_drug', 'No such medicine');
    const ownerId = body?.shared === true ? null : userId();
    if (nameTaken(access.tenantId, name, ownerId)) return taken();
    state.created += 1;
    const set: Stored = {
      id: `pset_new_${state.created}`,
      tenantId: access.tenantId,
      name,
      ownerId,
      archived: false,
      version: 1,
      updatedAt: new Date().toISOString(),
      lines,
    };
    state.sets.push(set);
    if (key) state.replies.set(`${access.tenantId}:${key}`, { raw, id: set.id });
    return HttpResponse.json<SetDetail>(detail(set), { status: 201 });
  }),

  http.get('*/api/prescription-sets/:setId', ({ request, params }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    seed();
    const set = find(access.tenantId, String(params.setId));
    return set ? HttpResponse.json<SetDetail>(detail(set)) : notFound();
  }),

  http.get('*/api/me/favourite-drugs', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    return HttpResponse.json<FavouriteDrugs>(favouritesOf(access.tenantId));
  }),

  http.put('*/api/me/favourite-drugs', async ({ request }) => {
    const manage = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in manage) return manage.denied;
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = (await request.json().catch(() => null)) as { drugIds?: unknown } | null;
    const ids = body?.drugIds;
    if (
      !Array.isArray(ids) ||
      ids.length > FAVOURITES_MAX ||
      ids.some((id) => typeof id !== 'string')
    ) {
      return invalid();
    }
    const list = ids as string[];
    const usable = list.every((id) => {
      const drug = mockDrug(access.tenantId, id);
      return drug && drug.type === 'medicine' && !drug.archived;
    });
    if (new Set(list).size !== list.length || !usable) {
      return error(422, 'unknown_drug', 'No such medicine');
    }
    state.favourites.set(`${access.tenantId}:${userId()}`, list);
    return HttpResponse.json<FavouriteDrugs>(favouritesOf(access.tenantId));
  }),
];
