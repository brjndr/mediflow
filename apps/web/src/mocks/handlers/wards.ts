import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { onMockReset, TENANT_IDS } from '../db';
import { authorize, error } from '../respond';
import { mockDepartment, mockDepartmentNamed } from './departments';
import { mockServiceNamed } from './services';

type Schemas = components['schemas'];
type BedCategory = Schemas['BedCategory'];
type BedCategoryPage = Schemas['BedCategoryPage'];
type Ward = Schemas['Ward'];
type WardPage = Schemas['WardPage'];
type WardDetail = Schemas['WardDetail'];
type Bed = Schemas['Bed'];
type Status = Bed['status'];
type BlockReason = NonNullable<Bed['blockedReason']>;

const BLOCK_REASONS: readonly BlockReason[] = [
  'repair',
  'maintenance',
  'deep_cleaning',
  'reserved',
  'other',
];

const FEATURE_FLAG = 'wards';
const READ = 'ward:read';
const MANAGE = 'ward:manage';
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** What is stored: ids for what is named elsewhere. Names and counts are read when shown. */
interface StoredCategory {
  id: string;
  tenantId: string;
  name: string;
  serviceId?: string;
  archived: boolean;
  version: number;
}
interface StoredWard {
  id: string;
  tenantId: string;
  code: string;
  name: string;
  floor?: string;
  departmentId?: string;
  archived: boolean;
  version: number;
}
interface StoredRoom {
  id: string;
  wardId: string;
  name: string;
  archived: boolean;
  version: number;
}
interface StoredBed {
  id: string;
  wardId: string;
  roomId: string;
  number: string;
  bedCategoryId: string;
  status: Status;
  blockedReason?: BlockReason;
  blockedNote?: string;
  archived: boolean;
  version: number;
}

interface State {
  categories: StoredCategory[];
  wards: StoredWard[];
  rooms: StoredRoom[];
  beds: StoredBed[];
  created: number;
  /** What each Idempotency-Key was answered with, by hospital and key. */
  replies: Map<string, { raw: string; id: string }>;
}

/** The hospital's main wards: code, name, floor, department, category, rooms x beds. */
const MAIN: [string, string, string, string | null, string, number, number][] = [
  ['GW-A', 'General ward A', 'Ground floor', 'General Medicine', 'general', 2, 12],
  ['GW-B', 'General ward B', 'Ground floor', 'General Surgery', 'general', 2, 12],
  ['SP-1', 'Semi-private wing', '1st floor', null, 'semi', 6, 2],
  ['PV-1', 'Private wing', '2nd floor', null, 'private', 8, 1],
  ['ICU', 'Intensive care unit', '3rd floor', 'Intensive Care', 'icu', 1, 8],
  ['DC', 'Day care', 'Ground floor', null, 'daycare', 1, 6],
];

/** More than one page of wards at the hospital, with beds in every status. */
function seed(): State {
  const state: State = {
    categories: [],
    wards: [],
    rooms: [],
    beds: [],
    created: 0,
    replies: new Map(),
  };
  const category = (tenantId: string, id: string, name: string, service?: string) =>
    state.categories.push({
      id,
      tenantId,
      name,
      serviceId: service ? mockServiceNamed(tenantId, service)?.id : undefined,
      archived: false,
      version: 1,
    });
  const H = TENANT_IDS.hospital;
  category(H, 'bcat_h_general', 'General ward', 'General ward bed day');
  category(H, 'bcat_h_semi', 'Semi-private', 'Semi-private room day');
  category(H, 'bcat_h_private', 'Private room', 'Private room day');
  category(H, 'bcat_h_icu', 'Intensive care', 'ICU bed day');
  category(H, 'bcat_h_daycare', 'Day care', 'Day-care bed');
  // Set up, and not linked to a charge yet.
  category(H, 'bcat_h_isolation', 'Isolation');
  state.categories.push({
    id: 'bcat_h_old',
    tenantId: H,
    name: 'Deluxe suite',
    archived: true,
    version: 2,
  });

  const ward = (
    tenantId: string,
    prefix: string,
    [code, name, floor, department, kind, rooms, beds]: (typeof MAIN)[number],
  ) => {
    const id = `${prefix}_${code.toLowerCase()}`;
    state.wards.push({
      id,
      tenantId,
      code,
      name,
      floor,
      departmentId: department ? mockDepartmentNamed(tenantId, department)?.id : undefined,
      archived: false,
      version: 1,
    });
    let number = 0;
    for (let room = 1; room <= rooms; room++) {
      const roomId = `${id}_r${room}`;
      state.rooms.push({
        id: roomId,
        wardId: id,
        name: rooms === 1 ? 'Main hall' : beds > 2 ? `Hall ${room}` : `Room ${room}`,
        archived: false,
        version: 1,
      });
      for (let bed = 1; bed <= beds; bed++) {
        number += 1;
        state.beds.push({
          id: `${id}_b${number}`,
          wardId: id,
          roomId,
          number: `${code}-${String(number).padStart(2, '0')}`,
          bedCategoryId: `bcat_${prefix === 'ward_h' ? 'h' : 'c'}_${kind}`,
          status: 'available',
          archived: false,
          version: 1,
        });
      }
    }
  };
  for (const entry of MAIN) ward(H, 'ward_h', entry);
  for (let index = 7; index <= 30; index++) {
    const code = `W-${String(index).padStart(2, '0')}`;
    ward(H, 'ward_h', [
      code,
      `Ward ${String(index).padStart(2, '0')}`,
      '4th floor',
      null,
      'general',
      2,
      4,
    ]);
  }
  // Beds as admissions and housekeeping would have left them, and one taken out of use here.
  const set = (id: string, status: Status, blockedNote?: string) => {
    const bed = state.beds.find((candidate) => candidate.id === id);
    if (bed) {
      Object.assign(bed, { status }, blockedNote ? { blockedReason: 'repair', blockedNote } : {});
    }
  };
  set('ward_h_gw-a_b1', 'occupied');
  set('ward_h_gw-a_b2', 'occupied');
  set('ward_h_gw-a_b3', 'cleaning');
  set('ward_h_gw-a_b4', 'blocked', 'Oxygen outlet');
  set('ward_h_icu_b1', 'occupied');
  state.beds.push({
    id: 'ward_h_gw-a_bold',
    wardId: 'ward_h_gw-a',
    roomId: 'ward_h_gw-a_r1',
    number: 'GW-A-99',
    bedCategoryId: 'bcat_h_general',
    status: 'available',
    archived: true,
    version: 2,
  });
  state.wards.push({
    id: 'ward_h_old',
    tenantId: H,
    code: 'OLD',
    name: 'Old annexe',
    archived: true,
    version: 2,
  });

  // The clinic has its own category and one ward, with a code the hospital uses too.
  const C = TENANT_IDS.clinic;
  category(C, 'bcat_c_daycare', 'Observation');
  ward(C, 'ward_c', ['DC', 'Observation room', 'Ground floor', null, 'daycare', 1, 2]);
  return state;
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** What another member of staff does meanwhile: changes a ward behind the open screen. */
export function editMockWard(id: string, changes: Partial<StoredWard>): void {
  const ward = state.wards.find((candidate) => candidate.id === id);
  if (!ward) throw new Error(`Unknown mock ward: ${id}`);
  Object.assign(ward, changes, { version: ward.version + 1 });
}

/** The same for a bed and for a bed category. */
export function editMockBed(id: string, changes: Partial<StoredBed>): void {
  const bed = state.beds.find((candidate) => candidate.id === id);
  if (!bed) throw new Error(`Unknown mock bed: ${id}`);
  Object.assign(bed, changes, { version: bed.version + 1 });
}
export function editMockBedCategory(id: string, changes: Partial<StoredCategory>): void {
  const category = state.categories.find((candidate) => candidate.id === id);
  if (!category) throw new Error(`Unknown mock bed category: ${id}`);
  Object.assign(category, changes, { version: category.version + 1 });
}

/** What admissions or housekeeping do meanwhile: move a bed to another status. */
export function setMockBedStatus(id: string, status: Status): void {
  const bed = state.beds.find((candidate) => candidate.id === id);
  if (!bed) throw new Error(`Unknown mock bed: ${id}`);
  delete bed.blockedReason;
  delete bed.blockedNote;
  Object.assign(bed, { status, version: bed.version + 1 });
}

const invalid = () => error(400, 'validation_failed', 'The request is not valid');
const gone = (what: string) => error(404, `${what}_not_found`, `No such ${what}`);
const conflict = () => error(409, 'conflict', 'It has changed');
const refuse = (code: string) => error(409, code, 'Refused');

// Everything is looked up at the session's hospital: another hospital's does not exist.
const wardOf = (tenantId: string, id: unknown) =>
  state.wards.find((ward) => ward.id === id && ward.tenantId === tenantId);
const categoryOf = (tenantId: string, id: unknown) =>
  state.categories.find((category) => category.id === id && category.tenantId === tenantId);
const roomOf = (ward: StoredWard, id: unknown) =>
  state.rooms.find((room) => room.id === id && room.wardId === ward.id);
const bedOf = (ward: StoredWard, id: unknown) =>
  state.beds.find((bed) => bed.id === id && bed.wardId === ward.id);

const collator = new Intl.Collator('en', { sensitivity: 'base', numeric: true });
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
const inUse = (bed: StoredBed) =>
  !bed.archived && !state.rooms.find((room) => room.id === bed.roomId)?.archived;

function viewCategory(category: StoredCategory): BedCategory {
  const service = category.serviceId
    ? mockServiceNamed(category.tenantId, undefined, category.serviceId)
    : undefined;
  return {
    ...category,
    ...(service ? { serviceName: service.name } : {}),
    bedCount: state.beds.filter((bed) => bed.bedCategoryId === category.id && inUse(bed)).length,
  };
}

function viewWard(ward: StoredWard): Ward {
  const department = ward.departmentId
    ? mockDepartment(ward.tenantId, ward.departmentId)
    : undefined;
  return {
    ...ward,
    ...(department ? { departmentName: department.name } : {}),
    roomCount: state.rooms.filter((room) => room.wardId === ward.id && !room.archived).length,
    bedCount: state.beds.filter((bed) => bed.wardId === ward.id && inUse(bed)).length,
  };
}

function viewDetail(ward: StoredWard): WardDetail {
  return {
    ward: viewWard(ward),
    rooms: state.rooms
      .filter((room) => room.wardId === ward.id)
      .sort((a, b) => collator.compare(a.name, b.name))
      .map(({ wardId: _wardId, ...room }) => ({
        ...room,
        beds: state.beds
          .filter((bed) => bed.roomId === room.id)
          .sort((a, b) => collator.compare(a.number, b.number))
          .map(({ wardId: _ward, ...bed }) => ({
            ...bed,
            bedCategoryName: categoryOf(ward.tenantId, bed.bedCategoryId)?.name ?? '',
          })),
      })),
  };
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body: unknown = await request.json().catch(() => null);
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : null;
}

const oneOf = <Value extends string>(values: readonly Value[], value: unknown) =>
  values.find((candidate) => candidate === value);

const text = (value: unknown, max: number, required = true): string | null =>
  typeof value === 'string' && value.trim().length <= max && (!required || value.trim() !== '')
    ? value.trim()
    : null;

/**
 * Answers a request that carries an Idempotency-Key: the same key with the same request gets the
 * first answer again and adds nothing; `add` runs otherwise and names what it added.
 */
async function once(
  request: Request,
  tenantId: string,
  answer: (id: string) => Response | undefined,
  add: (body: Record<string, unknown>) => { id: string } | Response,
): Promise<Response> {
  const raw = await request.clone().text();
  const key = request.headers.get('idempotency-key');
  // A key belongs to one route at one hospital: the same key elsewhere is another request.
  const route = `${tenantId}:${new URL(request.url).pathname}:${key}`;
  const elsewhere = [...state.replies.keys()].some(
    (stored) => stored !== route && stored.startsWith(`${tenantId}:`) && stored.endsWith(`:${key}`),
  );
  if (key && elsewhere) {
    return error(422, 'idempotency_key_reuse', 'That key was used for another request');
  }
  const earlier = key ? state.replies.get(route) : undefined;
  if (earlier) {
    const replay = earlier.raw === raw ? answer(earlier.id) : undefined;
    return replay ?? error(422, 'idempotency_key_reuse', 'That key was used for another request');
  }
  const body = await readBody(request);
  if (!body) return invalid();
  const added = add(body);
  if (added instanceof Response) return added;
  if (key) state.replies.set(route, { raw, id: added.id });
  return answer(added.id) ?? invalid();
}

/**
 * A bed-day service of this hospital that is in use, or it is refused. The one a category
 * already has may have been archived since and stays. Empty text is no service.
 */
function readService(
  tenantId: string,
  value: unknown,
  current?: string,
): string | null | undefined {
  if (value === '') return undefined;
  if (typeof value !== 'string') return null;
  const service = mockServiceNamed(tenantId, undefined, value);
  if (!service || service.category !== 'bed') return null;
  return service.archived && service.id !== current ? null : service.id;
}

/** The ward of a request for its rooms or beds, or the answer that ends it. */
function wardFor(request: Request, wardId: unknown, changing = true) {
  const access = authorize(request, {
    permission: changing ? MANAGE : READ,
    featureFlag: FEATURE_FLAG,
  });
  if ('denied' in access) return { stop: access.denied };
  const ward = wardOf(access.tenantId, wardId);
  if (!ward) return { stop: gone('ward') };
  // Nothing of an archived ward is changed.
  if (changing && ward.archived) return { stop: refuse('ward_archived') };
  return { ward, tenantId: access.tenantId };
}

const created = (ward: StoredWard) =>
  HttpResponse.json<WardDetail>(viewDetail(ward), { status: 201 });
const saved = (ward: StoredWard) => HttpResponse.json<WardDetail>(viewDetail(ward));

function paged<Item>(request: Request, all: Item[], idOf: (item: Item) => string) {
  const params = new URL(request.url).searchParams;
  const limit = Math.min(Math.max(Number(params.get('limit')) || 25, 1), 100);
  const cursor = params.get('cursor');
  const start = cursor ? all.findIndex((item) => idOf(item) === cursor) : 0;
  if (start < 0) return null;
  const next = all[start + limit];
  return {
    items: all.slice(start, start + limit),
    nextCursor: next ? idOf(next) : null,
    // With the first page only, as the contract says.
    ...(cursor ? {} : { total: all.length }),
  };
}

export const wardsHandlers = [
  // --- bed categories ---
  http.get('*/api/bed-categories', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const archived = new URL(request.url).searchParams.get('archived') === 'true';
    // Tenant isolation: only rows of the session's tenant are ever considered.
    const visible = state.categories
      .filter((category) => category.tenantId === access.tenantId && category.archived === archived)
      .sort((a, b) => collator.compare(a.name, b.name));
    const page = paged(request, visible, (category) => category.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<BedCategoryPage>({ ...page, items: page.items.map(viewCategory) });
  }),

  http.post('*/api/bed-categories', ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    return once(
      request,
      tenantId,
      (id) => {
        const category = categoryOf(tenantId, id);
        return category && HttpResponse.json<BedCategory>(viewCategory(category), { status: 201 });
      },
      (body) => {
        const name = text(body.name, 100);
        const serviceId =
          body.serviceId === undefined ? undefined : readService(tenantId, body.serviceId);
        if (!name || serviceId === null) return invalid();
        const taken = state.categories.some(
          (other) => other.tenantId === tenantId && same(other.name, name),
        );
        if (taken) return refuse('bed_category_name_taken');
        state.created += 1;
        const category: StoredCategory = {
          id: `bcat_new_${state.created}`,
          tenantId,
          name,
          ...(serviceId ? { serviceId } : {}),
          archived: false,
          version: 1,
        };
        state.categories.push(category);
        return category;
      },
    );
  }),

  http.patch('*/api/bed-categories/:id', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (!body || typeof body.expectedVersion !== 'number') return invalid();
    const category = categoryOf(access.tenantId, params.id);
    if (!category) return gone('bed_category');
    if (category.version !== body.expectedVersion) return conflict();
    const next = { ...category };
    if (body.name !== undefined) {
      const name = text(body.name, 100);
      if (!name) return invalid();
      const taken = state.categories.some(
        (other) =>
          other.id !== category.id && other.tenantId === access.tenantId && same(other.name, name),
      );
      if (taken) return refuse('bed_category_name_taken');
      next.name = name;
    }
    if (body.serviceId !== undefined) {
      const serviceId = readService(access.tenantId, body.serviceId, category.serviceId);
      if (serviceId === null) return invalid();
      if (serviceId) next.serviceId = serviceId;
      else delete next.serviceId;
    }
    // Sending what it already has changes nothing.
    if (JSON.stringify(next) !== JSON.stringify(category)) next.version = category.version + 1;
    state.categories[state.categories.indexOf(category)] = next;
    return HttpResponse.json<BedCategory>(viewCategory(next));
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/bed-categories/:id/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const category = categoryOf(access.tenantId, params.id);
      if (!category) return gone('bed_category');
      const archived = action === 'archive';
      // Doing it twice is harmless, so a retried request cannot fail.
      if (category.archived !== archived) {
        const used = state.beds.some((bed) => bed.bedCategoryId === category.id && !bed.archived);
        if (archived && used) return refuse('bed_category_in_use');
        category.archived = archived;
        category.version += 1;
      }
      return HttpResponse.json<BedCategory>(viewCategory(category));
    }),
  ),

  // --- wards ---
  http.get('*/api/wards', ({ request }) => {
    const access = authorize(request, { permission: READ, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const params = new URL(request.url).searchParams;
    const words = (params.get('q') ?? '').toLowerCase().split(/\s+/).filter(Boolean);
    const archived = params.get('archived') === 'true';
    const visible = state.wards
      .filter((ward) => ward.tenantId === access.tenantId && ward.archived === archived)
      .filter((ward) => {
        const haystack = `${ward.code} ${ward.name}`.toLowerCase();
        return words.every((word) => haystack.includes(word));
      })
      .sort((a, b) => collator.compare(a.name, b.name) || a.id.localeCompare(b.id));
    const page = paged(request, visible, (ward) => ward.id);
    if (!page) return error(400, 'invalid_cursor', 'Unknown cursor');
    return HttpResponse.json<WardPage>({ ...page, items: page.items.map(viewWard) });
  }),

  http.post('*/api/wards', ({ request }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    return once(
      request,
      tenantId,
      (id) => {
        const ward = wardOf(tenantId, id);
        return ward && created(ward);
      },
      (body) => {
        const code = text(body.code, 20);
        const name = text(body.name, 100);
        const floor = body.floor === undefined ? '' : text(body.floor, 50, false);
        if (!code || !CODE.test(code) || !name || floor === null) return invalid();
        // A department of this hospital that is in use, or it is refused.
        const department =
          body.departmentId === undefined
            ? undefined
            : mockDepartment(tenantId, String(body.departmentId));
        if (body.departmentId !== undefined && (!department || department.archived))
          return invalid();
        if (state.wards.some((other) => other.tenantId === tenantId && same(other.code, code))) {
          return refuse('ward_code_taken');
        }
        state.created += 1;
        const ward: StoredWard = {
          id: `ward_new_${state.created}`,
          tenantId,
          code,
          name,
          ...(floor ? { floor } : {}),
          ...(department ? { departmentId: department.id } : {}),
          archived: false,
          version: 1,
        };
        state.wards.push(ward);
        return ward;
      },
    );
  }),

  http.get('*/api/wards/:wardId', ({ request, params }) => {
    const found = wardFor(request, params.wardId, false);
    return 'stop' in found ? found.stop : saved(found.ward);
  }),

  http.patch('*/api/wards/:wardId', async ({ request, params }) => {
    const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
    if ('denied' in access) return access.denied;
    const body = await readBody(request);
    if (!body || typeof body.expectedVersion !== 'number') return invalid();
    // The code is never changed.
    if (body.code !== undefined) return invalid();
    const ward = wardOf(access.tenantId, params.wardId);
    if (!ward) return gone('ward');
    if (ward.version !== body.expectedVersion) return conflict();
    const next = { ...ward };
    if (body.name !== undefined) {
      const name = text(body.name, 100);
      if (!name) return invalid();
      next.name = name;
    }
    if (body.floor !== undefined) {
      const floor = text(body.floor, 50, false);
      if (floor === null) return invalid();
      if (floor) next.floor = floor;
      else delete next.floor;
    }
    if (body.departmentId !== undefined) {
      if (body.departmentId === '') delete next.departmentId;
      else {
        const department = mockDepartment(access.tenantId, String(body.departmentId));
        // The one it already has may have been archived since: only a new one has to be in use.
        if (!department || (department.archived && department.id !== ward.departmentId)) {
          return invalid();
        }
        next.departmentId = department.id;
      }
    }
    if (JSON.stringify(next) !== JSON.stringify(ward)) next.version = ward.version + 1;
    state.wards[state.wards.indexOf(ward)] = next;
    return saved(next);
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/wards/:wardId/${action}`, ({ request, params }) => {
      const access = authorize(request, { permission: MANAGE, featureFlag: FEATURE_FLAG });
      if ('denied' in access) return access.denied;
      const ward = wardOf(access.tenantId, params.wardId);
      if (!ward) return gone('ward');
      const archived = action === 'archive';
      if (ward.archived !== archived) {
        const occupied = state.beds.some(
          (bed) => bed.wardId === ward.id && bed.status === 'occupied' && !bed.archived,
        );
        if (archived && occupied) return refuse('ward_has_occupied_beds');
        ward.archived = archived;
        ward.version += 1;
      }
      return saved(ward);
    }),
  ),

  // --- rooms ---
  http.post('*/api/wards/:wardId/rooms', ({ request, params }) => {
    const found = wardFor(request, params.wardId);
    if ('stop' in found) return found.stop;
    const { ward, tenantId } = found;
    return once(
      request,
      tenantId,
      () => created(ward),
      (body) => {
        const name = text(body.name, 50);
        if (!name) return invalid();
        const taken = state.rooms.some((room) => room.wardId === ward.id && same(room.name, name));
        if (taken) return refuse('room_name_taken');
        state.created += 1;
        const room = {
          id: `room_new_${state.created}`,
          wardId: ward.id,
          name,
          archived: false,
          version: 1,
        };
        state.rooms.push(room);
        return room;
      },
    );
  }),

  http.patch('*/api/wards/:wardId/rooms/:roomId', async ({ request, params }) => {
    const found = wardFor(request, params.wardId);
    if ('stop' in found) return found.stop;
    const body = await readBody(request);
    const name = text(body?.name, 50);
    if (!body || typeof body.expectedVersion !== 'number' || !name) return invalid();
    const room = roomOf(found.ward, params.roomId);
    if (!room) return gone('room');
    // An archived room is restored before it is changed.
    if (room.archived) return refuse('room_archived');
    if (room.version !== body.expectedVersion) return conflict();
    const taken = state.rooms.some(
      (other) => other.id !== room.id && other.wardId === room.wardId && same(other.name, name),
    );
    if (taken) return refuse('room_name_taken');
    if (room.name !== name) {
      room.name = name;
      room.version += 1;
    }
    return saved(found.ward);
  }),

  ...(['archive', 'restore'] as const).map((action) =>
    http.post(`*/api/wards/:wardId/rooms/:roomId/${action}`, ({ request, params }) => {
      const found = wardFor(request, params.wardId);
      if ('stop' in found) return found.stop;
      const room = roomOf(found.ward, params.roomId);
      if (!room) return gone('room');
      const archived = action === 'archive';
      if (room.archived !== archived) {
        const beds = state.beds.filter((bed) => bed.roomId === room.id && !bed.archived);
        if (archived && beds.some((bed) => bed.status === 'occupied')) {
          return refuse('room_has_occupied_beds');
        }
        // A room goes with its beds, each keeping its status. Coming back, each bed is
        // restored on its own.
        if (archived) {
          for (const bed of beds) Object.assign(bed, { archived: true, version: bed.version + 1 });
        }
        room.archived = archived;
        room.version += 1;
      }
      return saved(found.ward);
    }),
  ),

  // --- beds ---
  http.post('*/api/wards/:wardId/rooms/:roomId/beds', ({ request, params }) => {
    const found = wardFor(request, params.wardId);
    if ('stop' in found) return found.stop;
    const { ward, tenantId } = found;
    const room = roomOf(ward, params.roomId);
    if (!room) return gone('room');
    return once(
      request,
      tenantId,
      () => created(ward),
      (body) => {
        const number = text(body.number, 20);
        const category = categoryOf(tenantId, body.bedCategoryId);
        if (room.archived) return refuse('room_archived');
        if (!number || !category || category.archived) return invalid();
        if (state.beds.some((bed) => bed.wardId === ward.id && same(bed.number, number))) {
          return refuse('bed_number_taken');
        }
        state.created += 1;
        const bed: StoredBed = {
          id: `bed_new_${state.created}`,
          wardId: ward.id,
          roomId: room.id,
          number,
          bedCategoryId: category.id,
          status: 'available',
          archived: false,
          version: 1,
        };
        state.beds.push(bed);
        return bed;
      },
    );
  }),

  http.patch('*/api/wards/:wardId/beds/:bedId', async ({ request, params }) => {
    const found = wardFor(request, params.wardId);
    if ('stop' in found) return found.stop;
    const body = await readBody(request);
    if (!body || typeof body.expectedVersion !== 'number') return invalid();
    // The status is never set from here.
    if (body.status !== undefined) return invalid();
    const bed = bedOf(found.ward, params.bedId);
    if (!bed) return gone('bed');
    // An archived bed is restored before it is changed.
    if (bed.archived) return refuse('bed_archived');
    if (bed.version !== body.expectedVersion) return conflict();
    const next = { ...bed };
    if (body.number !== undefined) {
      const number = text(body.number, 20);
      if (!number) return invalid();
      const taken = state.beds.some(
        (other) => other.id !== bed.id && other.wardId === bed.wardId && same(other.number, number),
      );
      if (taken) return refuse('bed_number_taken');
      next.number = number;
    }
    if (body.bedCategoryId !== undefined) {
      const category = categoryOf(found.tenantId, body.bedCategoryId);
      // The one it already has may have been archived since: only a new one has to be in use.
      if (!category || (category.archived && category.id !== bed.bedCategoryId)) return invalid();
      next.bedCategoryId = category.id;
    }
    if (JSON.stringify(next) !== JSON.stringify(bed)) next.version = bed.version + 1;
    state.beds[state.beds.indexOf(bed)] = next;
    return saved(found.ward);
  }),

  ...(['block', 'unblock', 'archive', 'restore'] as const).map((action) =>
    http.post(`*/api/wards/:wardId/beds/:bedId/${action}`, async ({ request, params }) => {
      const found = wardFor(request, params.wardId);
      if ('stop' in found) return found.stop;
      const body = action === 'block' ? await readBody(request) : null;
      const reason = oneOf(BLOCK_REASONS, body?.reason);
      const note = body?.note === undefined ? '' : text(body.note, 100, false);
      if (action === 'block' && (!reason || note === null)) return invalid();
      const bed = bedOf(found.ward, params.bedId);
      if (!bed) return gone('bed');
      const touch = (changes: Partial<StoredBed>) =>
        Object.assign(bed, changes, { version: bed.version + 1 });
      // The transitions, checked on the bed as it is now.
      if (action === 'block') {
        if (bed.archived || bed.status !== 'available') return refuse('bed_not_available');
        touch({ status: 'blocked', blockedReason: reason, ...(note ? { blockedNote: note } : {}) });
      } else if (action === 'unblock') {
        if (bed.archived || bed.status !== 'blocked') return refuse('bed_not_blocked');
        delete bed.blockedReason;
        delete bed.blockedNote;
        touch({ status: 'available' });
      } else if (action === 'archive' && !bed.archived) {
        if (bed.status === 'occupied') return refuse('bed_occupied');
        // The status is kept: archiving is no way round housekeeping, or round a block.
        touch({ archived: true });
      } else if (action === 'restore' && bed.archived) {
        if (roomOf(found.ward, bed.roomId)?.archived) return refuse('room_archived');
        if (categoryOf(found.tenantId, bed.bedCategoryId)?.archived) {
          return refuse('bed_category_archived');
        }
        touch({ archived: false });
      }
      return saved(found.ward);
    }),
  ),
];
