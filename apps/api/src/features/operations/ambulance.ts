import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import {
  Ambulance,
  AmbulanceCreate,
  AmbulanceListQuery,
  AmbulanceParams,
  AmbulancePage,
  AmbulanceServiceChange,
  AmbulanceTrip,
  AmbulanceTripCreate,
  AmbulanceTripMove,
  AmbulanceTripPage,
  TripListQuery,
  TripParams,
} from './schemas.js';
import { isCode, iso, requirePatient, userIdOf } from './util.js';

const FEATURE = 'ambulance';

type TripStatus = AmbulanceTrip['status'];
export const TRIP_TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  requested: ['dispatched', 'cancelled'],
  dispatched: ['picked_up', 'cancelled'],
  picked_up: ['completed'],
  completed: [],
  cancelled: [],
};

interface AmbulanceRow {
  id: string;
  tenant_id: string;
  registration: string;
  kind: Ambulance['kind'];
  status: Ambulance['status'];
  version: number;
}
const AMBULANCES = `select x.id, x.tenant_id, x.registration, x.kind, x.status, x.version,
       x.created_at from ambulances x`;
const ambulanceView = (row: AmbulanceRow): Ambulance => ({
  id: row.id,
  tenantId: row.tenant_id,
  registration: row.registration,
  kind: row.kind,
  status: row.status,
  version: row.version,
});

interface TripRow {
  id: string;
  tenant_id: string;
  patient_id: string | null;
  encounter_id: string | null;
  service_id: string | null;
  service_name: string | null;
  ambulance_id: string | null;
  registration: string | null;
  pickup: string;
  destination: string;
  status: TripStatus;
  requested_at: Date;
  dispatched_at: Date | null;
  picked_up_at: Date | null;
  finished_at: Date | null;
  version: number;
}
const TRIPS = `select x.id, x.tenant_id, x.patient_id, x.encounter_id, x.service_id,
       sv.name as service_name, x.ambulance_id, a.registration, x.pickup,
       x.destination, x.status, x.requested_at, x.dispatched_at, x.picked_up_at, x.finished_at,
       x.version
  from ambulance_trips x
  left join ambulances a on a.tenant_id = x.tenant_id and a.id = x.ambulance_id
  left join services sv on sv.tenant_id = x.tenant_id and sv.id = x.service_id`;
const tripView = (row: TripRow, crew: AmbulanceTrip['crew']): AmbulanceTrip => ({
  id: row.id,
  tenantId: row.tenant_id,
  ...(row.patient_id === null ? {} : { patientId: row.patient_id }),
  ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
  ...(row.service_id === null
    ? {}
    : { serviceId: row.service_id, serviceName: row.service_name ?? '' }),
  ...(row.ambulance_id === null
    ? {}
    : { ambulanceId: row.ambulance_id, ambulanceRegistration: row.registration ?? '' }),
  pickup: row.pickup,
  destination: row.destination,
  status: row.status,
  requestedAt: iso(row.requested_at),
  ...(row.dispatched_at === null ? {} : { dispatchedAt: iso(row.dispatched_at) }),
  ...(row.picked_up_at === null ? {} : { pickedUpAt: iso(row.picked_up_at) }),
  ...(row.finished_at === null ? {} : { finishedAt: iso(row.finished_at) }),
  crew,
  version: row.version,
});

interface CrewRow {
  trip_id: string;
  user_id: string;
  user_name: string;
  duty: AmbulanceTrip['crew'][number]['duty'];
}
/** The crew of the given trips, drivers first, in one query. */
async function crewOf(
  client: pg.ClientBase,
  tripIds: string[],
): Promise<Map<string, AmbulanceTrip['crew']>> {
  const byTrip = new Map<string, AmbulanceTrip['crew']>();
  if (tripIds.length === 0) return byTrip;
  const { rows } = await client.query<CrewRow>(
    `select c.trip_id, c.user_id, u.name as user_name, c.duty
       from ambulance_trip_crew c join users u on u.id = c.user_id
      where c.trip_id = any($1::uuid[])
      order by (c.duty <> 'driver'), u.name, c.user_id`,
    [tripIds],
  );
  for (const row of rows) {
    const list = byTrip.get(row.trip_id) ?? [];
    list.push({ userId: row.user_id, userName: row.user_name, duty: row.duty });
    byTrip.set(row.trip_id, list);
  }
  return byTrip;
}
async function viewOf(client: pg.ClientBase, row: TripRow): Promise<AmbulanceTrip> {
  return tripView(row, (await crewOf(client, [row.id])).get(row.id) ?? []);
}

async function findTrip(client: pg.ClientBase, id: string, lock = false): Promise<TripRow | null> {
  if (!isUuid(id)) return null;
  // `for update of x` locks the trip, not the ambulance it joins.
  const { rows } = await client.query<TripRow>(
    `${TRIPS} where x.id = $1 ${lock ? 'for update of x' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}
async function findAmbulance(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<AmbulanceRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<AmbulanceRow>(
    `${AMBULANCES} where x.id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * The crew named for a dispatch: each an active member of the hospital (422 `unknown_crew`), no
 * one twice or two drivers (422 `invalid_crew`), and no one already on a trip under way (409
 * `crew_busy`).
 */
async function checkCrew(
  client: pg.ClientBase,
  crew: { userId: string; duty: unknown }[],
): Promise<void> {
  const ids = crew.map((member) => member.userId);
  if (new Set(ids).size !== ids.length || crew.filter((m) => m.duty === 'driver').length > 1) {
    throw new HttpError(422, 'invalid_crew', 'One driver, and no one twice');
  }
  if (ids.length === 0) return;
  if (!ids.every(isUuid)) throw new HttpError(422, 'unknown_crew', 'No such staff member');
  const { rows: members } = await client.query(
    "select 1 from memberships where user_id = any($1::uuid[]) and status = 'active'",
    [ids],
  );
  if (members.length !== ids.length) {
    throw new HttpError(422, 'unknown_crew', 'No such staff member');
  }
  const { rows: busy } = await client.query(
    `select 1 from ambulance_trip_crew c join ambulance_trips t
       on t.tenant_id = c.tenant_id and t.id = c.trip_id
      where c.user_id = any($1::uuid[]) and t.status in ('dispatched', 'picked_up') limit 1`,
    [ids],
  );
  if (busy.length > 0) throw new HttpError(409, 'crew_busy', 'Someone is on another trip');
}

const tripGone = () => new HttpError(404, 'trip_not_found', 'No such trip');
const ambulanceGone = () => new HttpError(404, 'ambulance_not_found', 'No such ambulance');

export const ambulanceRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/ambulances',
    {
      config: { permissions: ['ambulance:read'], feature: FEATURE },
      schema: {
        operationId: 'listAmbulances',
        tags: ['ambulance'],
        description: 'The hospital’s ambulances, oldest first. Requires ambulance:read.',
        querystring: AmbulanceListQuery,
        response: { 200: ref(AmbulancePage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.status) {
        params.push(q.status);
        where.push(`x.status = $${params.length}`);
      }
      const page = await selectPage<AmbulanceRow>(request.txClient, {
        select: AMBULANCES,
        where,
        params,
        order: 'x.created_at',
        cursor: q.cursor,
        limit: q.limit ?? DEFAULT_PAGE_SIZE,
      });
      return { items: page.rows.map(ambulanceView), nextCursor: page.nextCursor };
    },
  );

  app.post(
    '/ambulances',
    {
      config: {
        permissions: ['ambulance:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createAmbulance',
        tags: ['ambulance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds an ambulance, available. The registration is unique in the hospital (409 `duplicate_registration`). The Idempotency-Key header is required. Audited. Requires ambulance:manage.',
        body: AmbulanceCreate,
        response: { 201: ref(Ambulance), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      try {
        const { rows } = await request.txClient.query<{ id: string }>(
          'insert into ambulances (registration, kind, created_by) values ($1, $2, $3) returning id',
          [body.registration.trim().toUpperCase(), body.kind, userIdOf(request)],
        );
        const id = (rows[0] as { id: string }).id;
        request.audit('create', 'ambulance', id);
        return reply
          .status(201)
          .send(ambulanceView((await findAmbulance(request.txClient, id)) as AmbulanceRow));
      } catch (error) {
        if (isCode(error, '23505', 'ambulances_registration')) {
          throw new HttpError(409, 'duplicate_registration', 'That registration exists');
        }
        throw error;
      }
    },
  );

  app.post(
    '/ambulances/:ambulanceId/service',
    {
      config: { permissions: ['ambulance:manage'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'setAmbulanceService',
        tags: ['ambulance'],
        headers: IdempotencyHeaders,
        description:
          'Takes an ambulance out of service, or returns it. Only an available ambulance goes out of service and only one out of service returns: one on a trip is 409 `invalid_transition` (dispatching and ending trips move it). The `version` is the ambulance’s, or 409 `conflict`. Audited. Requires ambulance:manage.',
        params: AmbulanceParams,
        body: AmbulanceServiceChange,
        response: { 200: ref(Ambulance), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const probe = await findAmbulance(client, request.params.ambulanceId);
      if (!probe) throw ambulanceGone();
      const row = (await findAmbulance(client, probe.id, true)) as AmbulanceRow;
      if (row.version !== request.body.version) {
        throw new HttpError(409, 'conflict', 'The ambulance has changed since it was read');
      }
      const to = request.body.status;
      const from = to === 'out_of_service' ? 'available' : 'out_of_service';
      if (row.status !== from) {
        throw new HttpError(409, 'invalid_transition', `Not from ${row.status}`);
      }
      await client.query('update ambulances set status = $2 where id = $1', [row.id, to]);
      request.audit('update', 'ambulance', row.id);
      return ambulanceView((await findAmbulance(client, row.id)) as AmbulanceRow);
    },
  );

  app.get(
    '/ambulance-trips',
    {
      config: { permissions: ['ambulance:read'], feature: FEATURE },
      schema: {
        operationId: 'listAmbulanceTrips',
        tags: ['ambulance'],
        description:
          'Trips, newest request first, filtered by status or ambulance. A trip with a patient is audited as a read of that patient’s trip. Requires ambulance:read.',
        querystring: TripListQuery,
        response: { 200: ref(AmbulanceTripPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.status) {
        params.push(q.status);
        where.push(`x.status = $${params.length}`);
      }
      if (q.ambulanceId) {
        params.push(q.ambulanceId);
        where.push(`x.ambulance_id::text = $${params.length}`);
      }
      const page = await selectPage<TripRow>(request.txClient, {
        select: TRIPS,
        where,
        params,
        order: 'x.requested_at',
        desc: true,
        cursor: q.cursor,
        limit: q.limit ?? DEFAULT_PAGE_SIZE,
      });
      for (const row of page.rows)
        if (row.patient_id) request.audit('read', 'ambulance_trip', row.id);
      const crews = await crewOf(
        request.txClient,
        page.rows.map((row) => row.id),
      );
      return {
        items: page.rows.map((row) => tripView(row, crews.get(row.id) ?? [])),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.post(
    '/ambulance-trips',
    {
      config: {
        permissions: ['ambulance:dispatch'],
        feature: FEATURE,
        idempotent: { body: 'ids', required: true },
      },
      schema: {
        operationId: 'requestAmbulanceTrip',
        tags: ['ambulance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Asks for a trip from a pick-up place to a destination, in status `requested`. A `patientId` is optional (an emergency may have no record yet) and must be one the caller may read (422 `unknown_patient`). An `encounterId` (a visit of that patient, not cancelled, else 422 `unknown_encounter`) and a `serviceId` (an active service, else 422 `unknown_service`; it needs the visit, else 422 `encounter_required`) make the trip billable: billing charges the service to the visit when the trip is completed. The Idempotency-Key header is required. Audited; emits `ambulance.trip_requested`. Requires ambulance:dispatch.',
        body: AmbulanceTripCreate,
        response: { 201: ref(AmbulanceTrip), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (body.patientId !== undefined) await requirePatient(request, body.patientId);
      if (body.encounterId !== undefined) {
        const { rows: visit } = await request.txClient.query(
          `select 1 from encounters where id::text = $1 and patient_id::text = $2
             and status <> 'cancelled'`,
          [body.encounterId, body.patientId ?? ''],
        );
        if (visit.length === 0) throw new HttpError(422, 'unknown_encounter', 'No such visit');
      }
      if (body.serviceId !== undefined) {
        if (body.encounterId === undefined) {
          throw new HttpError(422, 'encounter_required', 'A charge needs the visit it goes to');
        }
        const { rows: service } = await request.txClient.query(
          'select 1 from services where id::text = $1 and not archived',
          [body.serviceId],
        );
        if (service.length === 0) throw new HttpError(422, 'unknown_service', 'No such service');
      }
      const { rows } = await request.txClient.query<{ id: string }>(
        `insert into ambulance_trips (patient_id, encounter_id, service_id, pickup, destination,
           requested_by)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [
          body.patientId ?? null,
          body.encounterId ?? null,
          body.serviceId ?? null,
          body.pickup.trim(),
          body.destination.trim(),
          userIdOf(request),
        ],
      );
      const id = (rows[0] as { id: string }).id;
      request.audit('create', 'ambulance_trip', id);
      await request.emit('ambulance.trip_requested', id, { patientId: body.patientId ?? null });
      return reply
        .status(201)
        .send(await viewOf(request.txClient, (await findTrip(request.txClient, id)) as TripRow));
    },
  );

  app.post(
    '/ambulance-trips/:tripId/move',
    {
      config: {
        permissions: ['ambulance:dispatch'],
        feature: FEATURE,
        idempotent: { body: 'ids' },
      },
      schema: {
        operationId: 'moveAmbulanceTrip',
        tags: ['ambulance'],
        headers: IdempotencyHeaders,
        description:
          'Moves a trip: requested -> dispatched (with an `ambulanceId` of an available ambulance, which goes on the trip, and optionally the `crew`: active staff, one driver at most, none on a trip under way, else 422 `unknown_crew` / `invalid_crew` or 409 `crew_busy`; crew with any other move is 422 `crew_at_dispatch`) -> picked_up -> completed; cancelled before the pick-up (the ambulance is freed). Anything else is 409 `invalid_transition`. An ambulance on another trip or out of service is 409 `ambulance_unavailable`; an unknown one 422 `unknown_ambulance`. The `version` is the trip’s, or 409 `conflict`. Audited; emits `ambulance.trip_status_changed`. Requires ambulance:dispatch.',
        params: TripParams,
        body: AmbulanceTripMove,
        response: { 200: ref(AmbulanceTrip), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await findTrip(client, request.params.tripId);
      if (!probe) throw tripGone();
      const trip = (await findTrip(client, probe.id, true)) as TripRow;
      const to = body.to as TripStatus;
      if (trip.version !== body.version) {
        throw new HttpError(409, 'conflict', 'The trip has changed since it was read');
      }
      if (!TRIP_TRANSITIONS[trip.status].includes(to)) {
        throw new HttpError(409, 'invalid_transition', `Not from ${trip.status} to ${to}`);
      }
      let ambulanceId = trip.ambulance_id;
      if (body.crew !== undefined && to !== 'dispatched') {
        throw new HttpError(422, 'crew_at_dispatch', 'The crew is named when the trip is sent');
      }
      if (to === 'dispatched') {
        if (body.crew !== undefined) await checkCrew(client, body.crew);
        if (body.ambulanceId === undefined) {
          throw new HttpError(422, 'ambulance_required', 'Say which ambulance goes');
        }
        const ambulance = await findAmbulance(client, body.ambulanceId, true);
        if (!ambulance) throw new HttpError(422, 'unknown_ambulance', 'No such ambulance');
        if (ambulance.status !== 'available') {
          throw new HttpError(409, 'ambulance_unavailable', 'The ambulance cannot go now');
        }
        await client.query("update ambulances set status = 'on_trip' where id = $1", [
          ambulance.id,
        ]);
        ambulanceId = ambulance.id;
      }
      const stamp =
        to === 'dispatched'
          ? ', dispatched_at = now()'
          : to === 'picked_up'
            ? ', picked_up_at = now()'
            : ', finished_at = now()';
      try {
        await client.query(
          `update ambulance_trips set status = $2, ambulance_id = $3 ${stamp} where id = $1`,
          [trip.id, to, ambulanceId],
        );
      } catch (error) {
        if (isCode(error, '23505', 'ambulance_trips_one_live')) {
          throw new HttpError(409, 'ambulance_unavailable', 'The ambulance cannot go now');
        }
        throw error;
      }
      if (to === 'dispatched') {
        for (const member of body.crew ?? []) {
          await client.query(
            'insert into ambulance_trip_crew (trip_id, user_id, duty) values ($1, $2, $3)',
            [trip.id, member.userId, member.duty as string],
          );
        }
      }
      // The ambulance is free again once the trip ends or is called off.
      if ((to === 'completed' || to === 'cancelled') && trip.ambulance_id !== null) {
        await client.query(
          "update ambulances set status = 'available' where id = $1 and status = 'on_trip'",
          [trip.ambulance_id],
        );
      }
      request.audit('update', 'ambulance_trip', trip.id);
      await request.emit('ambulance.trip_status_changed', trip.id, {
        from: trip.status,
        to,
        ambulanceId,
        patientId: trip.patient_id,
        encounterId: trip.encounter_id,
        serviceId: trip.service_id,
      });
      return viewOf(client, (await findTrip(client, trip.id)) as TripRow);
    },
  );
};
