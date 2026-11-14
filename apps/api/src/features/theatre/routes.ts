import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { practisingDoctor } from '../doctors/index.js';
import { stockableDrug } from '../drugs/index.js';
import { stockIn, stockOut } from '../inventory/index.js';
import { orderableService } from '../services/index.js';
import type { SurgeryConsumable } from './schemas.js';
import {
  OtRoom,
  OtRoomCreate,
  OtRoomListQuery,
  OtRoomPage,
  OtRoomParams,
  OtRoomUpdate,
  MAX_RANGE_DAYS,
  Surgery,
  SurgeryCancel,
  SurgeryConsumableCreate,
  SurgeryConsumableListQuery,
  SurgeryConsumableReturnCreate,
  SurgeryConsumableReturnParams,
  SurgeryConsumablePage,
  SurgeryCreate,
  SurgeryListQuery,
  SurgeryPage,
  SurgeryParams,
  SurgeryProgress,
  SurgeryReschedule,
} from './schemas.js';
import { instant, isUuid, requireModule, requirePatient, userIdOf } from './util.js';

const FEATURE = 'theatre';
const DAY_MS = 86_400_000;

// --- theatres -----------------------------------------------------------------------------------

interface RoomRow {
  id: string;
  tenant_id: string;
  name: string;
  archived: boolean;
  version: number;
}
const roomView = (row: RoomRow): OtRoom => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  archived: row.archived,
  version: row.version,
});

async function findRoom(client: pg.ClientBase, id: string, lock = false): Promise<RoomRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<RoomRow>(
    `select id, tenant_id, name, archived, version from ot_rooms where id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const isUniqueViolation = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === '23505';

// --- surgeries ----------------------------------------------------------------------------------

interface SurgeryRow {
  id: string;
  tenant_id: string;
  room_id: string;
  surgeon_id: string;
  patient_id: string;
  service_id: string | null;
  encounter_id: string | null;
  procedure: string;
  notes: string | null;
  starts_at: Date;
  ends_at: Date;
  status: Surgery['status'];
  started_at: Date | null;
  completed_at: Date | null;
  cancelled_at: Date | null;
  version: number;
}
const COLUMNS = `s.id, s.tenant_id, s.room_id, s.surgeon_id, s.patient_id, s.service_id, s.encounter_id, s.procedure,
       s.notes, s.starts_at, s.ends_at, s.status, s.started_at, s.completed_at, s.cancelled_at,
       s.version`;
const iso = (value: Date) => value.toISOString();
const view = (row: SurgeryRow): Surgery => ({
  id: row.id,
  tenantId: row.tenant_id,
  roomId: row.room_id,
  surgeonId: row.surgeon_id,
  patientId: row.patient_id,
  ...(row.service_id === null ? {} : { serviceId: row.service_id }),
  ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
  procedure: row.procedure,
  ...(row.notes === null ? {} : { notes: row.notes }),
  startsAt: iso(row.starts_at),
  endsAt: iso(row.ends_at),
  status: row.status,
  ...(row.started_at === null ? {} : { startedAt: iso(row.started_at) }),
  ...(row.completed_at === null ? {} : { completedAt: iso(row.completed_at) }),
  ...(row.cancelled_at === null ? {} : { cancelledAt: iso(row.cancelled_at) }),
  version: row.version,
});

async function findSurgery(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<SurgeryRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<SurgeryRow>(
    `select ${COLUMNS} from ot_bookings s where s.id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Holds the theatre, the surgeon and the patient for the rest of the transaction, in a fixed
 * order, before a booking is written. The exclusion constraints still decide who wins; this only
 * lets two requests for the same resource queue instead of waiting on each other's index entries
 * (which Postgres ends with a deadlock error rather than the clean refusal).
 */
async function holdResources(client: pg.ClientBase, ids: readonly string[]): Promise<void> {
  for (const id of [...new Set(ids)].sort()) {
    await client.query('select pg_advisory_xact_lock(hashtextextended($1::text, 0))', [id]);
  }
}

const surgeryGone = () => new HttpError(404, 'surgery_not_found', 'No such surgery');
const consumableGone = () =>
  new HttpError(404, 'consumable_not_found', 'No such recorded consumable in this surgery');

/** The surgery to change, locked, at the version the caller read, in one of the statuses. */
async function lockedSurgery(
  client: pg.ClientBase,
  id: string,
  version: number,
  allowed: readonly Surgery['status'][],
): Promise<SurgeryRow> {
  const probe = await findSurgery(client, id);
  if (!probe) throw surgeryGone();
  const row = (await findSurgery(client, probe.id, true)) as SurgeryRow;
  if (row.version !== version) {
    throw new HttpError(409, 'version_conflict', 'The surgery has changed since it was read');
  }
  if (!allowed.includes(row.status)) {
    throw new HttpError(
      409,
      'invalid_transition',
      `A surgery that is ${row.status} cannot do that`,
    );
  }
  return row;
}

/** The refusal for a booking an exclusion constraint turned down, or the error itself. */
function bookingRefusal(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code !== '23P01') return error;
  if (constraint === 'ot_bookings_room_free') {
    return new HttpError(409, 'room_taken', 'The theatre is booked at that time');
  }
  if (constraint === 'ot_bookings_surgeon_free') {
    return new HttpError(409, 'surgeon_busy', 'The surgeon is booked at that time');
  }
  if (constraint === 'ot_bookings_patient_free') {
    return new HttpError(409, 'patient_busy', 'The patient is booked at that time');
  }
  return error;
}

/** A span that ends in the future, at most a day long, as the database also demands. */
function span(startsAt: string, endsAt: string): { start: Date; end: Date } {
  const start = instant(startsAt);
  const end = instant(endsAt);
  if (end.getTime() <= start.getTime() || end.getTime() - start.getTime() > DAY_MS) {
    throw new HttpError(422, 'invalid_time', 'A surgery ends after it starts, within a day');
  }
  if (end.getTime() <= Date.now()) {
    throw new HttpError(422, 'in_the_past', 'That time has already passed');
  }
  return { start, end };
}

async function usableRoom(client: pg.ClientBase, id: string): Promise<void> {
  const room = await findRoom(client, id);
  if (!room || room.archived) throw new HttpError(422, 'unknown_room', 'No such theatre in use');
}
async function usableSurgeon(client: pg.ClientBase, id: string): Promise<void> {
  if (!(await practisingDoctor(client, id))) {
    throw new HttpError(422, 'unknown_surgeon', 'No such doctor in practice here');
  }
}

const replyWith = async (client: pg.ClientBase, id: string): Promise<Surgery> => {
  const row = await findSurgery(client, id);
  if (!row) throw surgeryGone();
  return view(row);
};

// The calendar is ordered by start; its cursor carries the start and the id.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00$/;
interface Cursor {
  a: string;
  i: string;
}
function decode(cursor: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof value.a === 'string' &&
      PG_TIMESTAMP.test(value.a) &&
      typeof value.i === 'string' &&
      isUuid(value.i)
    ) {
      return { a: value.a, i: value.i };
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
}
const encode = (cursor: Cursor) => Buffer.from(JSON.stringify(cursor)).toString('base64url');

interface ConsumableRow {
  id: string;
  use_id: string;
  drug_id: string;
  batch_id: string;
  location_id: string;
  quantity: number;
  returned_quantity: number;
  ledger_entry_id: string;
  item_name: string;
  batch_number: string;
  location_name: string;
  recorded_by: string;
  recorded_at: Date;
}
const CONSUMABLE_COLUMNS = `c.id, c.use_id, c.drug_id, c.batch_id, c.location_id, c.quantity,
       coalesce((select sum(r.quantity)::int from ot_consumable_returns r where r.consumable_id = c.id), 0) as returned_quantity,
       c.ledger_entry_id, c.recorded_by, c.recorded_at,
       (select d.generic_name from drugs d where d.id = c.drug_id) as item_name,
       (select b.batch_number from stock_batches b where b.id = c.batch_id) as batch_number,
       (select l.name from stock_locations l where l.id = c.location_id) as location_name`;
const consumableView = (row: ConsumableRow): SurgeryConsumable => ({
  id: row.id,
  useId: row.use_id,
  drugId: row.drug_id,
  batchId: row.batch_id,
  locationId: row.location_id,
  quantity: row.quantity,
  returnedQuantity: row.returned_quantity,
  ledgerEntryId: row.ledger_entry_id,
  itemName: row.item_name,
  batchNumber: row.batch_number,
  locationName: row.location_name,
  recordedBy: row.recorded_by,
  recordedAt: iso(row.recorded_at),
});

export const theatreRoutes: FastifyPluginAsyncTypebox = async (app) => {
  // --- theatres ---------------------------------------------------------------------------------

  app.get(
    '/theatre/rooms',
    {
      config: { permissions: ['theatre:read'], feature: FEATURE },
      schema: {
        operationId: 'listTheatreRooms',
        tags: ['theatre'],
        description:
          'The hospital’s operation theatres by name. Archived ones only with `archived=true`. Requires theatre:read.',
        querystring: OtRoomListQuery,
        response: { 200: ref(OtRoomPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.archived !== true) where.push('not r.archived');
      if (q.cursor) {
        const parts = decodeRoomCursor(q.cursor);
        params.push(parts.n, parts.i);
        where.push(
          `(lower(r.name), r.id) > ($${params.length - 1}::text, $${params.length}::uuid)`,
        );
      }
      const limit = q.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await request.txClient.query<RoomRow>(
        `select r.id, r.tenant_id, r.name, r.archived, r.version from ot_rooms r
          ${where.length ? `where ${where.join(' and ')}` : ''}
          order by lower(r.name), r.id limit $${params.length}`,
        params,
      );
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      return {
        items: page.map(roomView),
        nextCursor:
          more && last
            ? Buffer.from(JSON.stringify({ n: last.name.toLowerCase(), i: last.id })).toString(
                'base64url',
              )
            : null,
      };
    },
  );

  app.post(
    '/theatre/rooms',
    {
      config: {
        permissions: ['theatre:manage'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createTheatreRoom',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds an operation theatre. A name already in use (any letter case) is 409 `name_taken`. The Idempotency-Key header is required. Audited. Requires theatre:manage.',
        body: OtRoomCreate,
        response: { 201: ref(OtRoom), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      if (request.replayOf !== null && request.idempotentId) {
        const room = await findRoom(client, request.idempotentId);
        if (room) return reply.status(201).send(roomView(room));
      }
      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          'insert into ot_rooms (name) values ($1) returning id',
          [request.body.name.trim()],
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HttpError(409, 'name_taken', 'A theatre has that name');
        }
        throw error;
      }
      request.idempotentId = id;
      request.audit('create', 'ot_room', id);
      return reply.status(201).send(roomView((await findRoom(client, id)) as RoomRow));
    },
  );

  app.patch(
    '/theatre/rooms/:roomId',
    {
      config: { permissions: ['theatre:manage'], feature: FEATURE },
      schema: {
        operationId: 'updateTheatreRoom',
        tags: ['theatre'],
        description:
          'Renames a theatre or retires it (`archived`), at the `version` read (409 `version_conflict`). A retired theatre keeps its past surgeries and takes no new booking. Archiving one with a surgery still scheduled or in progress is 409 `in_use`. Audited. Requires theatre:manage.',
        params: OtRoomParams,
        body: OtRoomUpdate,
        response: { 200: ref(OtRoom), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const probe = await findRoom(client, request.params.roomId);
      if (!probe) throw new HttpError(404, 'room_not_found', 'No such theatre');
      const row = (await findRoom(client, probe.id, true)) as RoomRow;
      if (row.version !== request.body.version) {
        throw new HttpError(409, 'version_conflict', 'The theatre has changed since it was read');
      }
      const name = request.body.name?.trim() ?? row.name;
      const archived = request.body.archived ?? row.archived;
      if (archived && !row.archived) {
        const { rows } = await client.query<{ n: string }>(
          `select count(*) as n from ot_bookings
            where room_id = $1 and status in ('scheduled', 'in_progress')`,
          [row.id],
        );
        if (Number((rows[0] as { n: string }).n) > 0) {
          throw new HttpError(409, 'in_use', 'The theatre has surgeries scheduled');
        }
      }
      try {
        await client.query('update ot_rooms set name = $2, archived = $3 where id = $1', [
          row.id,
          name,
          archived,
        ]);
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new HttpError(409, 'name_taken', 'A theatre has that name');
        }
        throw error;
      }
      request.audit('update', 'ot_room', row.id);
      return roomView((await findRoom(client, row.id)) as RoomRow);
    },
  );

  // --- the schedule -----------------------------------------------------------------------------

  app.get(
    '/theatre/surgeries',
    {
      config: { permissions: ['theatre:read'], feature: FEATURE },
      schema: {
        operationId: 'listSurgeries',
        tags: ['theatre'],
        description: `The surgeries that overlap the time between \`from\` and \`to\` (at most ${MAX_RANGE_DAYS} days, else 422 \`range_too_wide\`), by start, for the theatre calendar; narrowed by theatre, surgeon or status. Cancelled ones are included only with \`status=cancelled\`. Every surgery listed is audited as a read. Requires theatre:read.`,
        querystring: SurgeryListQuery,
        response: { 200: ref(SurgeryPage), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const from = instant(q.from);
      const to = instant(q.to);
      if (to.getTime() <= from.getTime()) {
        throw new HttpError(422, 'invalid_time', '`to` is after `from`');
      }
      if (to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
        throw new HttpError(422, 'range_too_wide', `At most ${MAX_RANGE_DAYS} days at a time`);
      }
      const params: unknown[] = [from.toISOString(), to.toISOString()];
      const where = ['s.starts_at < $2::timestamptz', 's.ends_at > $1::timestamptz'];
      if (q.status) {
        params.push(q.status);
        where.push(`s.status = $${params.length}`);
      } else {
        where.push("s.status <> 'cancelled'");
      }
      for (const [value, column] of [
        [q.roomId, 's.room_id'],
        [q.surgeonId, 's.surgeon_id'],
      ] as const) {
        if (value === undefined) continue;
        // Not a uuid: nothing matches, the same as an id of another hospital.
        params.push(isUuid(value) ? value : '00000000-0000-0000-0000-000000000000');
        where.push(`${column} = $${params.length}`);
      }
      if (q.cursor) {
        const cursor = decode(q.cursor);
        params.push(cursor.a, cursor.i);
        where.push(
          `(s.starts_at, s.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const limit = q.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await request.txClient.query<SurgeryRow & { start_text: string }>(
        `select ${COLUMNS},
                to_char(s.starts_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as start_text
           from ot_bookings s
          where ${where.join(' and ')}
          order by s.starts_at, s.id
          limit $${params.length}`,
        params,
      );
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      for (const row of page) request.audit('read', 'surgery', row.id);
      return {
        items: page.map(view),
        nextCursor: more && last ? encode({ a: last.start_text, i: last.id }) : null,
      };
    },
  );

  app.get(
    '/theatre/surgeries/:surgeryId',
    {
      config: { permissions: ['theatre:read'], feature: FEATURE },
      schema: {
        operationId: 'getSurgery',
        tags: ['theatre'],
        description: 'One surgery. Audited as a read. Requires theatre:read.',
        params: SurgeryParams,
        response: { 200: ref(Surgery), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await findSurgery(request.txClient, request.params.surgeryId);
      if (!row) throw surgeryGone();
      request.audit('read', 'surgery', row.id);
      return view(row);
    },
  );

  app.post(
    '/theatre/surgeries',
    {
      config: {
        permissions: ['surgery:schedule'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'scheduleSurgery',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Books a theatre and a surgeon for a patient between `startsAt` and `endsAt` (half-open, at most 24 hours, not already over). A theatre, a surgeon and a patient each hold one live booking (scheduled or in progress) at a time: database exclusion constraints decide between simultaneous requests, and the loser is 409 `room_taken`, `surgeon_busy` or `patient_busy`. An unknown or retired theatre is 422 `unknown_room`, a doctor not in practice 422 `unknown_surgeon`, a procedure service that is not one 422 `unknown_service`, and a patient the caller may not read (needs patient:read) or that does not exist 422 `unknown_patient`. The Idempotency-Key header is required: a repeat books nothing again. Audited; emits `surgery.scheduled`. Requires surgery:schedule.',
        body: SurgeryCreate,
        response: { 201: ref(Surgery), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      if (request.replayOf !== null && request.idempotentId) {
        request.audit('read', 'surgery', request.idempotentId);
        return reply.status(201).send(await replyWith(client, request.idempotentId));
      }
      const body = request.body;
      const { start, end } = span(body.startsAt, body.endsAt);
      await requirePatient(request, body.patientId);
      await usableRoom(client, body.roomId);
      await usableSurgeon(client, body.surgeonId);
      if (body.serviceId !== undefined) {
        if (!(await orderableService(client, body.serviceId, 'procedure'))) {
          throw new HttpError(422, 'unknown_service', 'No such procedure service');
        }
      }
      await holdResources(client, [body.roomId, body.surgeonId, body.patientId]);
      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into ot_bookings
             (room_id, surgeon_id, patient_id, service_id, procedure, notes, starts_at, ends_at, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            body.roomId,
            body.surgeonId,
            body.patientId,
            body.serviceId ?? null,
            body.procedure.trim(),
            body.notes?.trim() || null,
            start.toISOString(),
            end.toISOString(),
            userIdOf(request),
          ],
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        throw bookingRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'surgery', id);
      await request.emit('surgery.scheduled', id, {
        patientId: body.patientId,
        surgeonId: body.surgeonId,
        roomId: body.roomId,
      });
      return reply.status(201).send(await replyWith(client, id));
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/reschedule',
    {
      config: {
        permissions: ['surgery:schedule'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'rescheduleSurgery',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Moves a scheduled surgery to another time and, optionally, another theatre or surgeon. The surgery’s own old time never counts against it; the refusals are those of scheduling (409 `room_taken`, `surgeon_busy`, `patient_busy`; 422 `unknown_room`, `unknown_surgeon`, `invalid_time`, `in_the_past`). Only a scheduled surgery moves (409 `invalid_transition`), at the `version` read (409 `version_conflict`). The Idempotency-Key header is required. Audited; emits `surgery.scheduled`. Requires surgery:schedule.',
        params: SurgeryParams,
        body: SurgeryReschedule,
        response: { 200: ref(Surgery), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', request.params.surgeryId);
        return replyWith(client, request.params.surgeryId);
      }
      const body = request.body;
      const row = await lockedSurgery(client, request.params.surgeryId, body.version, [
        'scheduled',
      ]);
      const { start, end } = span(body.startsAt, body.endsAt);
      const roomId = body.roomId ?? row.room_id;
      const surgeonId = body.surgeonId ?? row.surgeon_id;
      if (roomId !== row.room_id) await usableRoom(client, roomId);
      if (surgeonId !== row.surgeon_id) await usableSurgeon(client, surgeonId);
      await holdResources(client, [roomId, surgeonId, row.patient_id]);
      try {
        await client.query(
          'update ot_bookings set room_id = $2, surgeon_id = $3, starts_at = $4, ends_at = $5 where id = $1',
          [row.id, roomId, surgeonId, start.toISOString(), end.toISOString()],
        );
      } catch (error) {
        throw bookingRefusal(error);
      }
      request.audit('update', 'surgery', row.id);
      await request.emit('surgery.scheduled', row.id, {
        patientId: row.patient_id,
        surgeonId,
        roomId,
        rescheduled: true,
      });
      return replyWith(client, row.id);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/cancel',
    {
      config: {
        permissions: ['surgery:schedule'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'cancelSurgery',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Cancels a scheduled surgery with a reason, which frees the theatre, the surgeon and the patient for the time. A surgery already started cannot be cancelled (409 `invalid_transition`); a stale `version` is 409 `version_conflict`. The Idempotency-Key header is required. Audited; emits `surgery.cancelled` (the reason is kept on the surgery, never in the event). Requires surgery:schedule.',
        params: SurgeryParams,
        body: SurgeryCancel,
        response: { 200: ref(Surgery), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', request.params.surgeryId);
        return replyWith(client, request.params.surgeryId);
      }
      const row = await lockedSurgery(client, request.params.surgeryId, request.body.version, [
        'scheduled',
      ]);
      await client.query(
        "update ot_bookings set status = 'cancelled', cancelled_at = now(), cancel_reason = $2 where id = $1",
        [row.id, request.body.reason.trim()],
      );
      request.audit('update', 'surgery', row.id);
      await request.emit('surgery.cancelled', row.id, {
        patientId: row.patient_id,
        roomId: row.room_id,
      });
      return replyWith(client, row.id);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/start',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'startSurgery',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'The surgery begins: scheduled to in progress, at the `version` read (409 `version_conflict`; any other status 409 `invalid_transition`). The Idempotency-Key header is required. Audited; emits `surgery.started`. Requires surgery:perform.',
        params: SurgeryParams,
        body: SurgeryProgress,
        response: { 200: ref(Surgery), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', request.params.surgeryId);
        return replyWith(client, request.params.surgeryId);
      }
      const row = await lockedSurgery(client, request.params.surgeryId, request.body.version, [
        'scheduled',
      ]);
      await client.query(
        "update ot_bookings set status = 'in_progress', started_at = now() where id = $1",
        [row.id],
      );
      request.audit('update', 'surgery', row.id);
      await request.emit('surgery.started', row.id, {
        patientId: row.patient_id,
        surgeonId: row.surgeon_id,
        roomId: row.room_id,
      });
      return replyWith(client, row.id);
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/complete',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'completeSurgery',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'The surgery is over: in progress to completed, final, at the `version` read (409 `version_conflict`; any other status 409 `invalid_transition`). The Idempotency-Key header is required. Audited; emits `surgery.completed` with the patient, surgeon, theatre and procedure service, for billing and records to react to. Requires surgery:perform.',
        params: SurgeryParams,
        body: SurgeryProgress,
        response: { 200: ref(Surgery), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'surgery', request.params.surgeryId);
        return replyWith(client, request.params.surgeryId);
      }
      const row = await lockedSurgery(client, request.params.surgeryId, request.body.version, [
        'in_progress',
      ]);
      await client.query(
        "update ot_bookings set status = 'completed', completed_at = now() where id = $1",
        [row.id],
      );
      request.audit('update', 'surgery', row.id);
      await request.emit('surgery.completed', row.id, {
        patientId: row.patient_id,
        surgeonId: row.surgeon_id,
        roomId: row.room_id,
        ...(row.service_id === null ? {} : { serviceId: row.service_id }),
        ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
      });
      return replyWith(client, row.id);
    },
  );

  // --- consumables ------------------------------------------------------------------------------

  app.get(
    '/theatre/surgeries/:surgeryId/consumables',
    {
      config: { permissions: ['theatre:read'], feature: FEATURE },
      schema: {
        operationId: 'listSurgeryConsumables',
        tags: ['theatre'],
        description:
          'The stock used in a surgery, oldest first: each batch taken, with the ledger entry that moved the stock. Audited as a read of the surgery. Requires theatre:read.',
        params: SurgeryParams,
        querystring: SurgeryConsumableListQuery,
        response: { 200: ref(SurgeryConsumablePage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const surgery = await findSurgery(client, request.params.surgeryId);
      if (!surgery) throw surgeryGone();
      const q = request.query;
      const params: unknown[] = [surgery.id];
      const where = ['c.booking_id = $1'];
      if (q.cursor) {
        const cursor = decode(q.cursor);
        params.push(cursor.a, cursor.i);
        where.push(
          `(c.recorded_at, c.id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const limit = q.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await client.query<ConsumableRow & { at_text: string }>(
        `select ${CONSUMABLE_COLUMNS},
                to_char(c.recorded_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as at_text
           from ot_consumables c
          where ${where.join(' and ')}
          order by c.recorded_at, c.id
          limit $${params.length}`,
        params,
      );
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      request.audit('read', 'surgery', surgery.id);
      return {
        items: page.map(consumableView),
        nextCursor: more && last ? encode({ a: last.at_text, i: last.id }) : null,
      };
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/consumables',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'recordSurgeryConsumables',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records an item used in a surgery that is in progress or completed, from named batches at a stock place, and takes the units out of stock through the inventory ledger in the same transaction (source `theatre`): more than a batch holds is 409 `insufficient_stock`, an expired batch 409 `batch_expired`, a batch that is not the item’s 422 `unknown_batch`, a place not in use 422 `unknown_location`, an item that is not in use 422 `unknown_item`. A scheduled or cancelled surgery is 409 `invalid_transition`. Needs the inventory module (403 `feature_disabled`). Emits `stock.low` when the item falls to its reorder level. The Idempotency-Key header is required: a repeat takes nothing out again and answers with what was recorded. Audited. Requires surgery:perform.',
        params: SurgeryParams,
        body: SurgeryConsumableCreate,
        response: { 201: ref(SurgeryConsumablePage), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      if (request.replayOf !== null && request.idempotentId) {
        const { rows } = await client.query<ConsumableRow>(
          `select ${CONSUMABLE_COLUMNS} from ot_consumables c where c.use_id = $1 and c.booking_id = $2 order by c.recorded_at, c.id`,
          [request.idempotentId, request.params.surgeryId],
        );
        request.audit('read', 'surgery', request.params.surgeryId);
        return reply.status(201).send({ items: rows.map(consumableView), nextCursor: null });
      }
      await requireModule(request, 'inventory');
      const probe = await findSurgery(client, request.params.surgeryId);
      if (!probe) throw surgeryGone();
      // The surgery first, then inventory's own locks, as every module that moves stock does.
      const surgery = (await findSurgery(client, probe.id, true)) as SurgeryRow;
      if (surgery.status !== 'in_progress' && surgery.status !== 'completed') {
        throw new HttpError(
          409,
          'invalid_transition',
          `Consumables are recorded once a surgery has started; this one is ${surgery.status}`,
        );
      }
      const body = request.body;
      const item = await stockableDrug(client, body.drugId);
      if (!item) throw new HttpError(422, 'unknown_item', 'No such item in use');
      const batchIds = body.lines.map((line) => line.batchId.toLowerCase());
      if (new Set(batchIds).size !== batchIds.length) {
        throw new HttpError(422, 'duplicate_batch', 'A batch is named once');
      }
      const useId = randomUUID();
      const actorId = userIdOf(request);
      const posted = await stockOut(request, {
        locationId: body.locationId.toLowerCase(),
        drugId: item.id,
        reorderLevel: item.reorderLevel,
        source: 'theatre',
        sourceId: useId,
        reason: 'theatre_use',
        actorId,
        lines: body.lines.map((line) => ({
          batchId: line.batchId.toLowerCase(),
          quantity: line.quantity,
        })),
      });
      for (const entry of posted) {
        await client.query(
          `insert into ot_consumables
             (booking_id, use_id, drug_id, batch_id, location_id, quantity, ledger_entry_id, recorded_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            surgery.id,
            useId,
            item.id,
            entry.batchId,
            body.locationId.toLowerCase(),
            entry.quantity,
            entry.ledgerEntryId,
            actorId,
          ],
        );
      }
      request.idempotentId = useId;
      await request.emit('surgery.consumables_used', surgery.id, {
        patientId: surgery.patient_id,
        useId,
        ...(surgery.encounter_id === null ? {} : { encounterId: surgery.encounter_id }),
      });
      request.audit('update', 'surgery', surgery.id);
      const { rows } = await client.query<ConsumableRow>(
        `select ${CONSUMABLE_COLUMNS} from ot_consumables c where c.use_id = $1 order by c.recorded_at, c.id`,
        [useId],
      );
      return reply.status(201).send({ items: rows.map(consumableView), nextCursor: null });
    },
  );

  app.post(
    '/theatre/surgeries/:surgeryId/consumables/:consumableId/return',
    {
      config: {
        permissions: ['surgery:perform'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'returnSurgeryConsumable',
        tags: ['theatre'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Brings units of a recorded consumable back to stock (#892), with a reason: they go back into the batch at the place they were taken from through the inventory ledger (source `theatre`, reason `theatre_return`) in the same transaction, never more than was used less what came back before (409 `over_return`), and an expired batch is never stock again (409 `batch_expired`). The return is a new row; the recording is not changed. Emits `surgery.consumables_returned`, on which billing voids a charge still pending and on no invoice, wholly returned, and flags any other for the billing desk to credit. A surgery that is not in progress or completed is 409 `invalid_transition`; an unknown recording 404 `consumable_not_found`. Needs the inventory module (403 `feature_disabled`). The Idempotency-Key header is required: a repeat moves no stock. Audited. Requires surgery:perform.',
        params: SurgeryConsumableReturnParams,
        body: SurgeryConsumableReturnCreate,
        response: { 201: ref(SurgeryConsumablePage), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const { surgeryId, consumableId } = request.params;
      const current = async (id: string) => {
        const { rows } = await client.query<ConsumableRow>(
          `select ${CONSUMABLE_COLUMNS} from ot_consumables c where c.id = $1 and c.booking_id = $2`,
          [id, surgeryId],
        );
        return rows.map(consumableView);
      };
      if (request.replayOf !== null && request.idempotentId) {
        const { rows } = await client.query<{ consumable_id: string }>(
          'select consumable_id from ot_consumable_returns where id = $1',
          [request.idempotentId],
        );
        request.audit('read', 'surgery', surgeryId);
        return reply.status(201).send({
          items: rows[0] ? await current(rows[0].consumable_id) : [],
          nextCursor: null,
        });
      }
      await requireModule(request, 'inventory');
      const probe = await findSurgery(client, surgeryId);
      if (!probe) throw surgeryGone();
      // The surgery first, then inventory's own locks, as every module that moves stock does.
      const surgery = (await findSurgery(client, probe.id, true)) as SurgeryRow;
      if (surgery.status !== 'in_progress' && surgery.status !== 'completed') {
        throw new HttpError(
          409,
          'invalid_transition',
          `Consumables come back once a surgery has started; this one is ${surgery.status}`,
        );
      }
      if (!isUuid(consumableId)) throw consumableGone();
      const [used] = await client
        .query<ConsumableRow>(
          `select ${CONSUMABLE_COLUMNS} from ot_consumables c where c.id = $1 and c.booking_id = $2`,
          [consumableId.toLowerCase(), surgery.id],
        )
        .then((result) => result.rows);
      if (!used) throw consumableGone();
      const body = request.body;
      if (body.quantity + used.returned_quantity > used.quantity) {
        throw new HttpError(
          409,
          'over_return',
          'More units than were used, less what came back before',
        );
      }
      const returnId = randomUUID();
      const actorId = userIdOf(request);
      const [posted] = await stockIn(request, {
        locationId: used.location_id,
        drugId: used.drug_id,
        source: 'theatre',
        sourceId: returnId,
        reason: 'theatre_return',
        actorId,
        lines: [{ batchId: used.batch_id, quantity: body.quantity }],
      });
      await client.query(
        `insert into ot_consumable_returns
           (id, booking_id, consumable_id, quantity, reason, ledger_entry_id, returned_by)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [returnId, surgery.id, used.id, body.quantity, body.reason, posted?.ledgerEntryId, actorId],
      );
      request.idempotentId = returnId;
      await request.emit('surgery.consumables_returned', surgery.id, {
        patientId: surgery.patient_id,
        consumableId: used.id,
        returnId,
        ...(surgery.encounter_id === null ? {} : { encounterId: surgery.encounter_id }),
      });
      request.audit('update', 'surgery', surgery.id);
      return reply.status(201).send({ items: await current(used.id), nextCursor: null });
    },
  );
};

function decodeRoomCursor(cursor: string): { n: string; i: string } {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      n?: unknown;
      i?: unknown;
    };
    if (typeof value.n === 'string' && typeof value.i === 'string' && isUuid(value.i)) {
      return { n: value.n, i: value.i };
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
}
