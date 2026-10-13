import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  archiveBed,
  archiveBedsOfRoom,
  bedNumberTaken,
  bedService,
  categoryInUse,
  categoryNameTaken,
  department,
  findBed,
  findCategory,
  findRoom,
  findWard,
  insertBed,
  insertCategory,
  insertRoom,
  insertWard,
  isTaken,
  listCategories,
  listWards,
  lockCategory,
  lockWard,
  moveBed,
  renameRoom,
  roomHasOccupiedBed,
  roomNameTaken,
  roomsAndBeds,
  setArchived,
  updateBed,
  updateCategory,
  updateWard,
  wardCodeTaken,
  wardHasOccupiedBed,
  wardSize,
  type BedRow,
  type CategoryRow,
  type WardRow,
} from './repository.js';
import type { Ward } from './schemas.js';
import {
  BED_NUMBER_MAX,
  BEDS_PER_WARD_MAX,
  BedBlock,
  BedCategory,
  BedCategoryCreate,
  BedCategoryListQuery,
  BedCategoryPage,
  BedCategoryUpdate,
  BedCreate,
  BedUpdate,
  FLOOR_MAX,
  NAME_MAX,
  NOTE_MAX,
  ROOM_NAME_MAX,
  ROOMS_PER_WARD_MAX,
  RoomCreate,
  RoomUpdate,
  WARD_SCHEMAS,
  WardCreate,
  WardDetail,
  WardListQuery,
  WardPage,
  WardUpdate,
  type Bed,
} from './schemas.js';

const FEATURE = 'wards';
const READ = 'ward:read';
const MANAGE = 'ward:manage';

const categoryView = (row: CategoryRow): BedCategory => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  ...(row.service_id === null ? {} : { serviceId: row.service_id }),
  ...(row.service_name === null ? {} : { serviceName: row.service_name }),
  bedCount: row.bed_count,
  archived: row.archived,
  version: row.version,
});

const wardView = (row: WardRow): Ward => ({
  id: row.id,
  tenantId: row.tenant_id,
  code: row.code,
  name: row.name,
  ...(row.floor === null ? {} : { floor: row.floor }),
  ...(row.department_id === null ? {} : { departmentId: row.department_id }),
  ...(row.department_name === null ? {} : { departmentName: row.department_name }),
  roomCount: row.room_count,
  bedCount: row.bed_count,
  archived: row.archived,
  version: row.version,
});

const bedView = (row: BedRow): Bed => ({
  id: row.id,
  roomId: row.room_id,
  number: row.number,
  bedCategoryId: row.bed_category_id,
  bedCategoryName: row.bed_category_name,
  status: row.status,
  ...(row.blocked_reason === null ? {} : { blockedReason: row.blocked_reason }),
  ...(row.blocked_note === null ? {} : { blockedNote: row.blocked_note }),
  archived: row.archived,
  version: row.version,
});

// Rooms and beds are read in the order people count them: "Bed 2" before "Bed 10". A ward has a
// bounded number of them, so they are put in order here, not in the database.
const natural = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

// One answer for what does not exist and what is another hospital's.
const gone = (what: 'ward' | 'room' | 'bed' | 'bed_category') =>
  new HttpError(404, `${what}_not_found`, `No such ${what.replace('_', ' ')}`);
const refuse = (code: string, message: string) => new HttpError(409, code, message);
const conflict = () => refuse('conflict', 'It has changed');
const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

/** A name as it is stored, and not empty once it is tidied. */
function cleanName(name: string, max: number): string {
  const tidied = tidyWithin(name, max);
  if (tidied === '') throw invalid('A name is required');
  return tidied;
}

/** The same id, whatever its capitals: a UUID is written either way. */
const sameId = (sent: string, held: string | null) => sent.toLowerCase() === held;

const OTHER_HOSPITAL =
  ' A ward of another hospital answers 404, the same as one that does not exist.';
const ARCHIVED_WARD =
  ' Nothing of an archived ward is changed (409 ward_archived): restore the ward first.';
const INSIDE =
  ' A room or a bed is looked up inside the ward named, and the ward at the session hospital: one of another ward or hospital answers 404.';

export const wardRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of WARD_SCHEMAS) app.addSchema(schema);

  const CategoryParams = Type.Object({ bedCategoryId: Type.String({ maxLength: 64 }) });
  const WardParams = Type.Object({ wardId: Type.String({ maxLength: 64 }) });
  const RoomParams = Type.Object({
    wardId: Type.String({ maxLength: 64 }),
    roomId: Type.String({ maxLength: 64 }),
  });
  const BedParams = Type.Object({
    wardId: Type.String({ maxLength: 64 }),
    bedId: Type.String({ maxLength: 64 }),
  });

  /** The ward with its rooms and their beds, as it is after the request's own changes. */
  async function detail(request: FastifyRequest, wardId: string): Promise<WardDetail> {
    const ward = await findWard(request.txClient, wardId);
    if (!ward) throw gone('ward');
    const { rooms, beds } = await roomsAndBeds(request.txClient, ward.id);
    const byRoom = new Map<string, BedRow[]>();
    for (const bed of beds) {
      const list = byRoom.get(bed.room_id);
      if (list) list.push(bed);
      else byRoom.set(bed.room_id, [bed]);
    }
    return {
      ward: wardView(ward),
      rooms: rooms
        .sort((a, b) => natural.compare(a.name, b.name) || a.id.localeCompare(b.id))
        .map((room) => ({
          id: room.id,
          name: room.name,
          beds: (byRoom.get(room.id) ?? [])
            .sort((a, b) => natural.compare(a.number, b.number) || a.id.localeCompare(b.id))
            .map(bedView),
          archived: room.archived,
          version: room.version,
        })),
    };
  }

  /**
   * The ward a change of one of its rooms or beds is made in: locked, so changes within a ward
   * take their turn, and in use.
   */
  async function wardToChange(request: FastifyRequest, wardId: string): Promise<WardRow> {
    const ward = await lockWard(request.txClient, wardId);
    if (!ward) throw gone('ward');
    if (ward.archived) throw refuse('ward_archived', 'Nothing of an archived ward is changed');
    return ward;
  }

  /**
   * The service a request names for a category: none for empty text, or a bed-day service of the
   * hospital that is in use. The one the category already has may have been archived since.
   */
  async function serviceFor(
    request: FastifyRequest,
    sent: string,
    current: string | null = null,
  ): Promise<string | null> {
    if (sent === '') return null;
    if (sameId(sent, current)) return current;
    const service = await bedService(request.txClient, sent);
    if (!service || service.archived) {
      throw invalid('serviceId is not a bed-day service of this hospital that is in use');
    }
    return sent.toLowerCase();
  }

  /** The same for the department of a ward. */
  async function departmentFor(
    request: FastifyRequest,
    sent: string,
    current: string | null = null,
  ): Promise<string | null> {
    if (sent === '') return null;
    if (sameId(sent, current)) return current;
    const found = await department(request.txClient, sent);
    if (!found || found.archived) {
      throw invalid('departmentId is not a department of this hospital that is in use');
    }
    return sent.toLowerCase();
  }

  /**
   * The category a request names for a bed: one of the hospital that is in use, held so that it
   * is not archived at the same moment. The one the bed already has may have been archived since.
   */
  async function categoryFor(
    request: FastifyRequest,
    sent: string,
    current: string | null = null,
  ): Promise<string> {
    const category = await lockCategory(request.txClient, sent, 'share');
    if (!category || (category.archived && category.id !== current)) {
      throw invalid('bedCategoryId is not a bed category of this hospital that is in use');
    }
    return category.id;
  }

  // An update names the fields that changed, never their values.
  const changed = (
    request: FastifyRequest,
    kind: string,
    id: string,
    change: string,
    fields?: string[],
  ) => request.emit('master.changed', id, { kind, change, ...(fields ? { fields } : {}) });

  /** The names of the fields that differ. */
  const differing = (pairs: Record<string, boolean>): string[] =>
    Object.entries(pairs)
      .filter(([, differs]) => differs)
      .map(([field]) => field);

  // --- bed categories --------------------------------------------------------------------------

  app.get(
    '/bed-categories',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listBedCategories',
        tags: ['wards'],
        description:
          'The bed categories of the active tenant, by name: the classes of bed it has, each charged as a bed-day service of the price catalog. `total` comes with the first page only.',
        querystring: BedCategoryListQuery,
        response: { 200: ref(BedCategoryPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, archived = false } = request.query;
      const list = await listCategories(request.txClient, { archived, cursor, limit });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(categoryView),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.post(
    '/bed-categories',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: { permissions: [MANAGE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createBedCategory',
        tags: ['wards'],
        headers: IdempotencyHeaders,
        description:
          "Adds a bed category. The hospital is the session's. A name already used by a category of the hospital, archived or not, whatever the capitals, is refused with 409 bed_category_name_taken. A `serviceId` must be a service of the same hospital in the bed category of the price catalog that is not archived (400 otherwise; on a change, the one the category already has may stay). Audited.",
        body: ref(BedCategoryCreate),
        response: { 201: ref(BedCategory), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as BedCategoryCreate;
      const name = cleanName(body.name, NAME_MAX);
      const serviceId =
        body.serviceId === undefined ? null : await serviceFor(request, body.serviceId);
      const taken = () =>
        refuse('bed_category_name_taken', 'The hospital has a bed category of that name');
      if (await categoryNameTaken(request.txClient, name)) throw taken();
      let id: string;
      try {
        id = await insertCategory(request.txClient, { name, serviceId });
      } catch (error) {
        // Two requests for the same new name at once: the database lets one through.
        if (isTaken(error, 'bed_categories_name_taken')) throw taken();
        throw error;
      }
      request.audit('create', 'bed_category', id);
      await changed(request, 'bed_category', id, 'created');
      const row = await findCategory(request.txClient, id);
      if (!row) throw gone('bed_category');
      return reply.status(201).send(categoryView(row));
    },
  );

  app.patch(
    '/bed-categories/:bedCategoryId',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'updateBedCategory',
        tags: ['wards'],
        description:
          'Changes a bed category. 409 conflict when it has changed since the version sent. The same rules as on adding hold. Empty text for `serviceId` removes the link. Sending what it already has changes nothing. A change applies to stays that start after it. Audited. A category of another hospital answers 404, the same as one that does not exist.',
        params: CategoryParams,
        body: ref(BedCategoryUpdate),
        response: { 200: ref(BedCategory), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as BedCategoryUpdate;
      const current = await lockCategory(request.txClient, request.params.bedCategoryId);
      if (!current) throw gone('bed_category');
      if (current.version !== body.expectedVersion) throw conflict();
      const name = body.name === undefined ? current.name : cleanName(body.name, NAME_MAX);
      const taken = () =>
        refuse('bed_category_name_taken', 'The hospital has a bed category of that name');
      if (name !== current.name && (await categoryNameTaken(request.txClient, name, current.id))) {
        throw taken();
      }
      const serviceId =
        body.serviceId === undefined
          ? current.service_id
          : await serviceFor(request, body.serviceId, current.service_id);
      const fields = differing({
        name: name !== current.name,
        serviceId: serviceId !== current.service_id,
      });
      if (fields.length > 0) {
        try {
          await updateCategory(request.txClient, current.id, { name, serviceId });
        } catch (error) {
          if (isTaken(error, 'bed_categories_name_taken')) throw taken();
          throw error;
        }
        request.audit('update', 'bed_category', current.id);
        await changed(request, 'bed_category', current.id, 'updated', fields);
      }
      const row = await findCategory(request.txClient, current.id);
      if (!row) throw gone('bed_category');
      return categoryView(row);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/bed-categories/:bedCategoryId/${action}`,
      {
        config: { permissions: [MANAGE, READ], feature: FEATURE },
        schema: {
          operationId: `${action}BedCategory`,
          tags: ['wards'],
          description:
            (action === 'archive'
              ? 'Archives a bed category: it is no longer offered for a bed. Refused with 409 bed_category_in_use while a bed that is not archived has it.'
              : 'Brings an archived bed category back.') +
            ' Doing it twice changes nothing. Audited. A category of another hospital answers 404, the same as one that does not exist.',
          params: CategoryParams,
          response: { 200: ref(BedCategory), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const archive = action === 'archive';
        // Held against a bed being given the category at the same moment.
        const current = await lockCategory(request.txClient, request.params.bedCategoryId);
        if (!current) throw gone('bed_category');
        if (archive && !current.archived && (await categoryInUse(request.txClient, current.id))) {
          throw refuse('bed_category_in_use', 'A bed in use has this category');
        }
        if (await setArchived(request.txClient, 'bed_categories', current.id, archive)) {
          request.audit(action, 'bed_category', current.id);
          await changed(request, 'bed_category', current.id, archive ? 'archived' : 'restored');
        }
        const row = await findCategory(request.txClient, current.id);
        if (!row) throw gone('bed_category');
        return categoryView(row);
      },
    );
  }

  // --- wards -----------------------------------------------------------------------------------

  app.get(
    '/wards',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listWards',
        tags: ['wards'],
        description:
          'The wards of the active tenant, by name, each with how many rooms and beds it has (archived ones not counted). Every word of `q` must be in the code or the name. `total` comes with the first page only.',
        querystring: WardListQuery,
        response: { 200: ref(WardPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, archived = false, q } = request.query;
      const list = await listWards(request.txClient, { q, archived, cursor, limit });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(wardView),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.post(
    '/wards',
    {
      // A new ward has no beds, so its answer holds no note: a replay can return it whole.
      config: { permissions: [MANAGE, READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createWard',
        tags: ['wards'],
        headers: IdempotencyHeaders,
        description:
          "Adds a ward, with no rooms yet. The hospital is the session's. The code cannot be changed later; one already used by a ward of the hospital, archived or not, whatever its capitals, is refused with 409 ward_code_taken. A `departmentId` must be a department of the same hospital that is not archived (400 otherwise). Audited.",
        body: ref(WardCreate),
        response: { 201: ref(WardDetail), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as WardCreate;
      const name = cleanName(body.name, NAME_MAX);
      const floor = tidyOptional(body.floor, FLOOR_MAX);
      const departmentId =
        body.departmentId === undefined ? null : await departmentFor(request, body.departmentId);
      const taken = () => refuse('ward_code_taken', 'The hospital has a ward of that code');
      if (await wardCodeTaken(request.txClient, body.code)) throw taken();
      let id: string;
      try {
        id = await insertWard(request.txClient, { code: body.code, name, floor, departmentId });
      } catch (error) {
        if (isTaken(error, 'wards_code_taken')) throw taken();
        throw error;
      }
      request.audit('create', 'ward', id);
      await changed(request, 'ward', id, 'created');
      return reply.status(201).send(await detail(request, id));
    },
  );

  app.get(
    '/wards/:wardId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getWard',
        tags: ['wards'],
        description:
          'One ward with its rooms and their beds, archived ones included, rooms and beds in the order people count them. A bed carries its status, and holds nothing about a patient.' +
          OTHER_HOSPITAL,
        params: WardParams,
        response: { 200: ref(WardDetail), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => detail(request, request.params.wardId),
  );

  app.patch(
    '/wards/:wardId',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'updateWard',
        tags: ['wards'],
        description:
          'Changes a ward: never its code. 409 conflict when the ward has changed since the version sent. Empty text removes the floor or the department; a new department must be one of the hospital that is not archived. Sending what the ward already has changes nothing. Audited.' +
          OTHER_HOSPITAL,
        params: WardParams,
        body: ref(WardUpdate),
        response: { 200: ref(WardDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as WardUpdate;
      const current = await lockWard(request.txClient, request.params.wardId);
      if (!current) throw gone('ward');
      if (current.version !== body.expectedVersion) throw conflict();
      const next = {
        name: body.name === undefined ? current.name : cleanName(body.name, NAME_MAX),
        floor: body.floor === undefined ? current.floor : tidyOptional(body.floor, FLOOR_MAX),
        departmentId:
          body.departmentId === undefined
            ? current.department_id
            : await departmentFor(request, body.departmentId, current.department_id),
      };
      const fields = differing({
        name: next.name !== current.name,
        floor: next.floor !== current.floor,
        departmentId: next.departmentId !== current.department_id,
      });
      if (fields.length > 0) {
        await updateWard(request.txClient, current.id, next);
        request.audit('update', 'ward', current.id);
        await changed(request, 'ward', current.id, 'updated', fields);
      }
      return detail(request, current.id);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/wards/:wardId/${action}`,
      {
        config: { permissions: [MANAGE, READ], feature: FEATURE },
        schema: {
          operationId: `${action}Ward`,
          tags: ['wards'],
          description:
            (action === 'archive'
              ? 'Archives a ward: it and its beds are no longer offered for an admission. Refused with 409 ward_has_occupied_beds while a bed of it is occupied, and the database refuses it too.'
              : 'Brings an archived ward back.') +
            ' Doing it twice changes nothing. Audited.' +
            OTHER_HOSPITAL,
          params: WardParams,
          response: { 200: ref(WardDetail), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const archive = action === 'archive';
        const current = await lockWard(request.txClient, request.params.wardId);
        if (!current) throw gone('ward');
        if (
          archive &&
          !current.archived &&
          (await wardHasOccupiedBed(request.txClient, current.id))
        ) {
          throw refuse('ward_has_occupied_beds', 'A bed of the ward is occupied');
        }
        if (await setArchived(request.txClient, 'wards', current.id, archive)) {
          request.audit(action, 'ward', current.id);
          await changed(request, 'ward', current.id, archive ? 'archived' : 'restored');
        }
        return detail(request, current.id);
      },
    );
  }

  // --- rooms -----------------------------------------------------------------------------------

  app.post(
    '/wards/:wardId/rooms',
    {
      // The answer is the whole ward, with the notes of its blocked beds: none of it is kept.
      config: { permissions: [MANAGE, READ], feature: FEATURE, idempotent: { body: 'none' } },
      schema: {
        operationId: 'createRoom',
        tags: ['wards'],
        headers: IdempotencyHeaders,
        description:
          'Adds a room to a ward. Every bed is in a room: an open ward is one room with many beds. A name another room of the ward has, archived or not, whatever its capitals, is refused with 409 room_name_taken. A ward has at most 200 rooms, archived ones counted (409 ward_room_limit). A repeat with the same Idempotency-Key adds nothing and is answered with the ward as it is then: the answer is the whole ward, which can hold notes on blocked beds, so nothing of it is kept. Audited.' +
          ARCHIVED_WARD +
          OTHER_HOSPITAL,
        params: WardParams,
        body: ref(RoomCreate),
        response: { 201: ref(WardDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      // A repeat of a request that went through: the ward as it is now, and no second room.
      if (request.replayOf !== null) {
        return reply.status(201).send(await detail(request, request.params.wardId));
      }
      const body = request.body as RoomCreate;
      const name = cleanName(body.name, ROOM_NAME_MAX);
      const ward = await wardToChange(request, request.params.wardId);
      if ((await wardSize(request.txClient, ward.id)).rooms >= ROOMS_PER_WARD_MAX) {
        throw refuse('ward_room_limit', 'The ward has as many rooms as a ward can have');
      }
      const taken = () => refuse('room_name_taken', 'The ward has a room of that name');
      if (await roomNameTaken(request.txClient, ward.id, name)) throw taken();
      let id: string;
      try {
        id = await insertRoom(request.txClient, ward.id, name);
      } catch (error) {
        if (isTaken(error, 'rooms_name_taken')) throw taken();
        throw error;
      }
      request.audit('create', 'room', id);
      await changed(request, 'room', id, 'created');
      return reply.status(201).send(await detail(request, ward.id));
    },
  );

  app.patch(
    '/wards/:wardId/rooms/:roomId',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'updateRoom',
        tags: ['wards'],
        description:
          'Renames a room. An archived room is restored before it is changed (409 room_archived). 409 conflict when the room has changed since the version sent, 409 room_name_taken for a name another room of the ward has. Audited.' +
          ARCHIVED_WARD +
          INSIDE,
        params: RoomParams,
        body: ref(RoomUpdate),
        response: { 200: ref(WardDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as RoomUpdate;
      const name = cleanName(body.name, ROOM_NAME_MAX);
      const ward = await wardToChange(request, request.params.wardId);
      const room = await findRoom(request.txClient, ward.id, request.params.roomId);
      if (!room) throw gone('room');
      if (room.archived) throw refuse('room_archived', 'Restore the room first');
      if (room.version !== body.expectedVersion) throw conflict();
      const taken = () => refuse('room_name_taken', 'The ward has a room of that name');
      if (await roomNameTaken(request.txClient, ward.id, name, room.id)) throw taken();
      if (room.name !== name) {
        try {
          await renameRoom(request.txClient, room.id, name);
        } catch (error) {
          if (isTaken(error, 'rooms_name_taken')) throw taken();
          throw error;
        }
        request.audit('update', 'room', room.id);
        await changed(request, 'room', room.id, 'updated', ['name']);
      }
      return detail(request, ward.id);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/wards/:wardId/rooms/:roomId/${action}`,
      {
        config: { permissions: [MANAGE, READ], feature: FEATURE },
        schema: {
          operationId: `${action}Room`,
          tags: ['wards'],
          description:
            (action === 'archive'
              ? 'Archives a room and with it the beds in it, each keeping its status. Refused with 409 room_has_occupied_beds while a bed of it is occupied.'
              : 'Brings an archived room back. Its beds stay archived until each is restored.') +
            ' Doing it twice changes nothing. Audited.' +
            ARCHIVED_WARD +
            INSIDE,
          params: RoomParams,
          response: { 200: ref(WardDetail), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const archive = action === 'archive';
        const ward = await wardToChange(request, request.params.wardId);
        const room = await findRoom(request.txClient, ward.id, request.params.roomId);
        if (!room) throw gone('room');
        if (room.archived !== archive) {
          if (archive) {
            if (await roomHasOccupiedBed(request.txClient, room.id)) {
              throw refuse('room_has_occupied_beds', 'A bed of the room is occupied');
            }
            // A room goes with its beds; coming back, each bed is restored on its own.
            for (const bedId of await archiveBedsOfRoom(request.txClient, room.id)) {
              request.audit('archive', 'bed', bedId);
              await changed(request, 'bed', bedId, 'archived');
            }
          }
          await setArchived(request.txClient, 'rooms', room.id, archive);
          request.audit(action, 'room', room.id);
          await changed(request, 'room', room.id, archive ? 'archived' : 'restored');
        }
        return detail(request, ward.id);
      },
    );
  }

  // --- beds ------------------------------------------------------------------------------------

  app.post(
    '/wards/:wardId/rooms/:roomId/beds',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE, idempotent: { body: 'none' } },
      schema: {
        operationId: 'createBed',
        tags: ['wards'],
        headers: IdempotencyHeaders,
        description:
          'Adds a bed to a room, available. A number another bed of the ward has, archived or not, whatever its capitals, is refused with 409 bed_number_taken. The room must be in use (409 room_archived), and the category a bed category of the same hospital that is not archived (400 otherwise). A ward has at most 1000 beds, archived ones counted (409 ward_bed_limit). A repeat with the same Idempotency-Key adds nothing and is answered with the ward as it is then: nothing of the answer is kept. Audited.' +
          ARCHIVED_WARD +
          INSIDE,
        params: RoomParams,
        body: ref(BedCreate),
        response: { 201: ref(WardDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      // A repeat of a request that went through: the ward as it is now, and no second bed.
      if (request.replayOf !== null) {
        return reply.status(201).send(await detail(request, request.params.wardId));
      }
      const body = request.body as BedCreate;
      const number = cleanName(body.number, BED_NUMBER_MAX);
      const ward = await wardToChange(request, request.params.wardId);
      if ((await wardSize(request.txClient, ward.id)).beds >= BEDS_PER_WARD_MAX) {
        throw refuse('ward_bed_limit', 'The ward has as many beds as a ward can have');
      }
      const room = await findRoom(request.txClient, ward.id, request.params.roomId);
      if (!room) throw gone('room');
      if (room.archived) throw refuse('room_archived', 'Restore the room first');
      const categoryId = await categoryFor(request, body.bedCategoryId);
      const taken = () => refuse('bed_number_taken', 'The ward has a bed of that number');
      if (await bedNumberTaken(request.txClient, ward.id, number)) throw taken();
      let id: string;
      try {
        id = await insertBed(request.txClient, {
          wardId: ward.id,
          roomId: room.id,
          number,
          categoryId,
        });
      } catch (error) {
        if (isTaken(error, 'beds_number_taken')) throw taken();
        throw error;
      }
      request.audit('create', 'bed', id);
      await changed(request, 'bed', id, 'created');
      return reply.status(201).send(await detail(request, ward.id));
    },
  );

  app.patch(
    '/wards/:wardId/beds/:bedId',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'updateBed',
        tags: ['wards'],
        description:
          'Changes the number or the category of a bed: never its status, which only the actions below and the admissions and housekeeping modules change. An archived bed is restored before it is changed (409 bed_archived). 409 conflict when the bed has changed since the version sent. A new category must be one of the hospital that is not archived; the one the bed has may have been archived since. A change of category applies to stays that start after it: an admission keeps the category and the service of the bed as they were when the patient was given it. Audited.' +
          ARCHIVED_WARD +
          INSIDE,
        params: BedParams,
        body: ref(BedUpdate),
        response: { 200: ref(WardDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as BedUpdate;
      const ward = await wardToChange(request, request.params.wardId);
      const bed = await findBed(request.txClient, ward.id, request.params.bedId);
      if (!bed) throw gone('bed');
      if (bed.archived) throw refuse('bed_archived', 'Restore the bed first');
      if (bed.version !== body.expectedVersion) throw conflict();
      const number =
        body.number === undefined ? bed.number : cleanName(body.number, BED_NUMBER_MAX);
      const taken = () => refuse('bed_number_taken', 'The ward has a bed of that number');
      if (
        number !== bed.number &&
        (await bedNumberTaken(request.txClient, ward.id, number, bed.id))
      ) {
        throw taken();
      }
      const categoryId =
        body.bedCategoryId === undefined
          ? bed.bed_category_id
          : await categoryFor(request, body.bedCategoryId, bed.bed_category_id);
      const fields = differing({
        number: number !== bed.number,
        bedCategoryId: categoryId !== bed.bed_category_id,
      });
      if (fields.length > 0) {
        try {
          await updateBed(request.txClient, bed.id, { number, categoryId });
        } catch (error) {
          if (isTaken(error, 'beds_number_taken')) throw taken();
          throw error;
        }
        request.audit('update', 'bed', bed.id);
        await changed(request, 'bed', bed.id, 'updated', fields);
      }
      return detail(request, ward.id);
    },
  );

  app.post(
    '/wards/:wardId/beds/:bedId/block',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'blockBed',
        tags: ['wards'],
        description:
          'Takes an available bed out of use, with a reason from the list and an optional note. Only an available bed that is not archived can be blocked: 409 bed_not_available otherwise. The transition is checked on the row, so two people cannot both make it. The note is never written to a log, an audit entry or an event. Audited.' +
          ARCHIVED_WARD +
          INSIDE,
        params: BedParams,
        body: ref(BedBlock),
        response: { 200: ref(WardDetail), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as BedBlock;
      const note = tidyOptional(body.note, NOTE_MAX);
      const ward = await wardToChange(request, request.params.wardId);
      const bed = await findBed(request.txClient, ward.id, request.params.bedId);
      if (!bed) throw gone('bed');
      const moved = await moveBed(request.txClient, bed.id, 'available', 'blocked', {
        reason: body.reason,
        note,
      });
      if (!moved) throw refuse('bed_not_available', 'Only an available bed is blocked');
      request.audit('block', 'bed', bed.id);
      await request.emit('master.changed', bed.id, {
        kind: 'bed',
        change: 'blocked',
        reason: body.reason,
      });
      return detail(request, ward.id);
    },
  );

  app.post(
    '/wards/:wardId/beds/:bedId/unblock',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'unblockBed',
        tags: ['wards'],
        description:
          'Puts a blocked bed back in use, available. 409 bed_not_blocked when it is not blocked, or is archived. The transition is checked on the row, so two people cannot both make it. Audited.' +
          ARCHIVED_WARD +
          INSIDE,
        params: BedParams,
        response: { 200: ref(WardDetail), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const ward = await wardToChange(request, request.params.wardId);
      const bed = await findBed(request.txClient, ward.id, request.params.bedId);
      if (!bed) throw gone('bed');
      if (!(await moveBed(request.txClient, bed.id, 'blocked', 'available', null))) {
        throw refuse('bed_not_blocked', 'The bed is not blocked');
      }
      request.audit('unblock', 'bed', bed.id);
      await changed(request, 'bed', bed.id, 'unblocked');
      return detail(request, ward.id);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/wards/:wardId/beds/:bedId/${action}`,
      {
        config: { permissions: [MANAGE, READ], feature: FEATURE },
        schema: {
          operationId: `${action}Bed`,
          tags: ['wards'],
          description:
            (action === 'archive'
              ? 'Archives a bed: it is no longer offered for an admission. Refused with 409 bed_occupied while it is occupied, and the database refuses it too. Archiving never changes the status: a bed that is being cleaned or blocked is still that when it is restored, so archiving is no way round housekeeping.'
              : 'Brings an archived bed back, in the status it had. Its room has to be in use (409 room_archived) and its category too (409 bed_category_archived).') +
            ' Doing it twice changes nothing. Audited.' +
            ARCHIVED_WARD +
            INSIDE,
          params: BedParams,
          response: { 200: ref(WardDetail), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const archive = action === 'archive';
        const ward = await wardToChange(request, request.params.wardId);
        const bed = await findBed(request.txClient, ward.id, request.params.bedId);
        if (!bed) throw gone('bed');
        if (bed.archived !== archive) {
          if (archive) {
            if (!(await archiveBed(request.txClient, bed.id))) {
              throw refuse('bed_occupied', 'The bed is occupied');
            }
          } else {
            const room = await findRoom(request.txClient, ward.id, bed.room_id);
            if (room?.archived) throw refuse('room_archived', 'Restore the room first');
            // Held, so that the category is not archived while its bed comes back.
            const category = await lockCategory(request.txClient, bed.bed_category_id, 'share');
            if (category?.archived) {
              throw refuse('bed_category_archived', 'Restore the bed category first');
            }
          }
          if (!archive) await setArchived(request.txClient, 'beds', bed.id, false);
          request.audit(action, 'bed', bed.id);
          await changed(request, 'bed', bed.id, archive ? 'archived' : 'restored');
        }
        return detail(request, ward.id);
      },
    );
  }
};
