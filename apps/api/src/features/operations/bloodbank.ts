import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import {
  BloodStock,
  BloodUnit,
  BloodUnitCreate,
  BloodUnitDetail,
  BloodUnitListQuery,
  BloodUnitMove,
  BloodUnitPage,
  BloodUnitParams,
  type BloodUnitStatusValue,
} from './schemas.js';
import { isCode, iso, requireGrant, requirePatient, userIdOf } from './util.js';

const FEATURE = 'bloodbank';
const READ = 'bloodUnit:read';
const MANAGE = 'bloodUnit:manage';
const ISSUE = 'bloodUnit:issue';

/**
 * The blood unit state machine. The database holds the same table (`blood_units_guard`); this one
 * gives the caller a clean refusal and says which permission a move needs.
 */
export const BLOOD_TRANSITIONS: Record<BloodUnitStatusValue, readonly BloodUnitStatusValue[]> = {
  collected: ['testing', 'discarded'],
  testing: ['available', 'discarded'],
  available: ['reserved', 'discarded', 'expired'],
  reserved: ['available', 'issued', 'discarded', 'expired'],
  issued: ['transfused', 'discarded'],
  transfused: [],
  discarded: [],
  expired: [],
};

/** Reserving, issuing and transfusing are the ward's side; testing and discarding the bank's. */
const permissionFor = (from: BloodUnitStatusValue, to: BloodUnitStatusValue): string =>
  to === 'reserved' ||
  to === 'issued' ||
  to === 'transfused' ||
  (from === 'reserved' && to === 'available')
    ? ISSUE
    : MANAGE;

interface UnitRow {
  id: string;
  tenant_id: string;
  unit_number: string;
  blood_group: BloodUnit['bloodGroup'];
  component: BloodUnit['component'];
  volume_ml: number;
  collected_at: Date;
  expires_at: Date;
  status: BloodUnitStatusValue;
  patient_id: string | null;
  version: number;
  expired: boolean;
}

const SELECT = `select x.id, x.tenant_id, x.unit_number, x.blood_group, x.component, x.volume_ml,
       x.collected_at, x.expires_at, x.status, x.patient_id, x.version, (x.expires_at <= now()) as expired
  from blood_units x`;

const view = (row: UnitRow): BloodUnit => ({
  id: row.id,
  tenantId: row.tenant_id,
  unitNumber: row.unit_number,
  bloodGroup: row.blood_group,
  component: row.component,
  volumeMl: row.volume_ml,
  collectedAt: iso(row.collected_at),
  expiresAt: iso(row.expires_at),
  status: row.status,
  ...(row.patient_id === null ? {} : { patientId: row.patient_id }),
  version: row.version,
});

async function find(client: pg.ClientBase, id: string, lock = false): Promise<UnitRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<UnitRow>(
    `${SELECT} where x.id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const notFound = () => new HttpError(404, 'blood_unit_not_found', 'No such blood unit');

export const bloodBankRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/blood-units',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listBloodUnits',
        tags: ['bloodbank'],
        description:
          'Blood units by expiry date, soonest first, with filters for status, group, component and the patient a unit is held for. Requires bloodUnit:read.',
        querystring: BloodUnitListQuery,
        response: { 200: ref(BloodUnitPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = [];
      const add = (sql: string, value: unknown) => {
        params.push(value);
        where.push(sql.replace('?', `$${params.length}`));
      };
      if (q.status) add('x.status = ?', q.status);
      if (q.bloodGroup) add('x.blood_group = ?', q.bloodGroup);
      if (q.component) add('x.component = ?', q.component);
      if (q.patientId) add('x.patient_id::text = ?', q.patientId);
      const page = await selectPage<UnitRow>(request.txClient, {
        select: SELECT,
        where,
        params,
        order: 'x.expires_at',
        cursor: q.cursor,
        limit: q.limit ?? DEFAULT_PAGE_SIZE,
      });
      return { items: page.rows.map(view), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/blood-units/stock',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getBloodStock',
        tags: ['bloodbank'],
        description:
          'What can be given now: for each group and component, the units available (cleared and not past their date) and reserved, and the nearest expiry. Requires bloodUnit:read.',
        response: { 200: ref(BloodStock), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      const { rows } = await request.txClient.query<{
        blood_group: BloodUnit['bloodGroup'];
        component: BloodUnit['component'];
        available: string;
        reserved: string;
        next_expiry: Date | null;
      }>(
        `select blood_group, component,
                count(*) filter (where status = 'available' and expires_at > now()) as available,
                count(*) filter (where status = 'reserved' and expires_at > now()) as reserved,
                min(expires_at) filter (where status in ('available', 'reserved') and expires_at > now()) as next_expiry
         from blood_units
         where status in ('available', 'reserved')
         group by blood_group, component
         order by blood_group, component`,
      );
      return {
        items: rows.map((row) => ({
          bloodGroup: row.blood_group,
          component: row.component,
          available: Number(row.available),
          reserved: Number(row.reserved),
          ...(row.next_expiry === null ? {} : { nextExpiry: iso(row.next_expiry) }),
        })),
      };
    },
  );

  app.post(
    '/blood-units',
    {
      config: {
        permissions: [MANAGE],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'registerBloodUnit',
        tags: ['bloodbank'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Registers a collected unit, in status `collected`. The expiry is after the collection (422 `invalid_period`); the unit number is the hospital’s own and unique (409 `duplicate_unit`). The Idempotency-Key header is required. Audited; emits `blood.unit_registered`. Requires bloodUnit:manage.',
        body: BloodUnitCreate,
        response: { 201: ref(BloodUnit), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const collected = new Date(body.collectedAt);
      const expires = new Date(body.expiresAt);
      if (!(expires > collected)) {
        throw new HttpError(422, 'invalid_period', 'A unit expires after it is collected');
      }
      const client = request.txClient;
      let id: string;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into blood_units (unit_number, blood_group, component, volume_ml, collected_at, expires_at, created_by)
           values ($1, $2, $3, $4, $5, $6, $7) returning id`,
          [
            body.unitNumber.trim(),
            body.bloodGroup,
            body.component,
            body.volumeMl,
            collected,
            expires,
            userIdOf(request),
          ],
        );
        id = (rows[0] as { id: string }).id;
      } catch (error) {
        if (isCode(error, '23505', 'blood_units_number')) {
          throw new HttpError(409, 'duplicate_unit', 'A unit with that number exists');
        }
        throw error;
      }
      await client.query(
        `insert into blood_unit_events (blood_unit_id, from_status, to_status, actor_id)
         values ($1, null, 'collected', $2)`,
        [id, userIdOf(request)],
      );
      request.audit('create', 'blood_unit', id);
      await request.emit('blood.unit_registered', id, {
        bloodGroup: body.bloodGroup,
        component: body.component,
      });
      return reply.status(201).send(view((await find(client, id)) as UnitRow));
    },
  );

  app.get(
    '/blood-units/:unitId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getBloodUnit',
        tags: ['bloodbank'],
        description:
          'A unit and every move it made, oldest first. A unit linked to a patient is audited as a read. 404 `blood_unit_not_found`. Requires bloodUnit:read.',
        params: BloodUnitParams,
        response: { 200: ref(BloodUnitDetail), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await find(request.txClient, request.params.unitId);
      if (!row) throw notFound();
      const { rows } = await request.txClient.query<{
        from_status: BloodUnitStatusValue | null;
        to_status: BloodUnitStatusValue;
        patient_id: string | null;
        reason: string | null;
        actor_id: string;
        occurred_at: Date;
      }>(
        `select from_status, to_status, patient_id, reason, actor_id, occurred_at
         from blood_unit_events where blood_unit_id = $1 order by occurred_at, id`,
        [row.id],
      );
      if (row.patient_id !== null) request.audit('read', 'blood_unit', row.id);
      return {
        unit: view(row),
        history: rows.map((entry) => ({
          ...(entry.from_status === null ? {} : { fromStatus: entry.from_status }),
          toStatus: entry.to_status,
          ...(entry.patient_id === null ? {} : { patientId: entry.patient_id }),
          ...(entry.reason === null ? {} : { reason: entry.reason }),
          actorId: entry.actor_id,
          occurredAt: iso(entry.occurred_at),
        })),
      };
    },
  );

  app.post(
    '/blood-units/:unitId/move',
    {
      config: { permissions: [READ], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'moveBloodUnit',
        tags: ['bloodbank'],
        headers: IdempotencyHeaders,
        description:
          'Moves a unit along its life: collected -> testing -> available -> reserved -> issued -> transfused; discarded from any state before transfusion (a `reason` is required); expired for an available or reserved unit past its date; reserved back to available. Anything else is 409 `invalid_transition`. Reserving needs a `patientId` the caller may read (422 `unknown_patient`) and a unit within its date (409 `unit_expired`). Testing, clearing for stock, discarding and expiring need bloodUnit:manage; reserving, issuing, transfusing and releasing a reservation need bloodUnit:issue (403 `permission_denied`). The `version` is the unit’s, or 409 `conflict`. Every move is kept in the unit’s history. Audited; emits `blood.unit_status_changed`.',
        params: BloodUnitParams,
        body: BloodUnitMove,
        response: { 200: ref(BloodUnit), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await find(client, request.params.unitId);
      if (!probe) throw notFound();
      const row = await find(client, probe.id, true);
      if (!row) throw notFound();
      const to = body.to as BloodUnitStatusValue;
      if (row.version !== body.version) {
        throw new HttpError(409, 'conflict', 'The unit has changed since it was read');
      }
      if (!BLOOD_TRANSITIONS[row.status].includes(to)) {
        throw new HttpError(409, 'invalid_transition', `Not from ${row.status} to ${to}`);
      }
      await requireGrant(request, permissionFor(row.status, to));
      if (to === 'discarded' && body.reason === undefined) {
        throw new HttpError(422, 'reason_required', 'Say why the unit is discarded');
      }
      if (to === 'expired' && !row.expired) {
        throw new HttpError(409, 'not_expired', 'The unit is within its date');
      }
      if ((to === 'reserved' || to === 'issued') && row.expired) {
        throw new HttpError(409, 'unit_expired', 'The unit is past its date');
      }
      let patientId: string | null = null;
      if (to === 'reserved') {
        if (body.patientId === undefined) {
          throw new HttpError(422, 'patient_required', 'Say which patient the unit is for');
        }
        await requirePatient(request, body.patientId);
        patientId = body.patientId;
      } else if (to === 'issued' || to === 'transfused') {
        patientId = row.patient_id;
      }
      try {
        await client.query('update blood_units set status = $2, patient_id = $3 where id = $1', [
          row.id,
          to,
          patientId,
        ]);
      } catch (error) {
        if (isCode(error, '23514')) {
          throw new HttpError(409, 'invalid_transition', `Not from ${row.status} to ${to}`);
        }
        throw error;
      }
      await client.query(
        `insert into blood_unit_events (blood_unit_id, from_status, to_status, patient_id, reason, actor_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [
          row.id,
          row.status,
          to,
          patientId ?? row.patient_id,
          body.reason ?? null,
          userIdOf(request),
        ],
      );
      request.audit('update', 'blood_unit', row.id);
      await request.emit('blood.unit_status_changed', row.id, {
        from: row.status,
        to,
        patientId: patientId ?? row.patient_id,
        bloodGroup: row.blood_group,
        component: row.component,
      });
      return view((await find(client, row.id)) as UnitRow);
    },
  );
};
