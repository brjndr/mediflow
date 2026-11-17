import { randomBytes } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { searchTerm } from '../../core/http/text.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { isUuid, selectPage } from './page.js';
import type { BloodDonorSummary } from './schemas.js';
import {
  BloodCollection,
  BloodCollectionCreate,
  BloodDonor,
  BloodDonorCreate,
  BloodDonorDefer,
  BloodDonorPage,
  BloodDonorParams,
  BloodDonorSearch,
  BloodDonorUpdate,
} from './schemas.js';
import { isCode, iso, userIdOf } from './util.js';

const FEATURE = 'bloodbank';
const READ = 'bloodDonor:read';
const MANAGE = 'bloodDonor:manage';

/** The donation rules of the blood bank, fixed here rather than set by a hospital. */
export const DONOR_MIN_AGE = 18;
export const DONOR_MAX_AGE = 65;
export const DONATION_INTERVAL_DAYS = 90;
const DAY = 24 * 60 * 60 * 1000;

/** Whole years between a birth date (`YYYY-MM-DD`) and a moment, counted on the UTC calendar. */
export function ageOn(dateOfBirth: string, on: Date): number {
  const [year, month, day] = dateOfBirth.split('-').map(Number) as [number, number, number];
  let age = on.getUTCFullYear() - year;
  const beforeBirthday =
    on.getUTCMonth() + 1 < month || (on.getUTCMonth() + 1 === month && on.getUTCDate() < day);
  if (beforeBirthday) age -= 1;
  return age;
}

const DOT = '•';
const maskName = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .map((word) => Array.from(word)[0] + DOT.repeat(Math.min(Array.from(word).length - 1, 4)))
    .join(' ');
const maskPhone = (phone: string): string => {
  const digits = phone.replace(/[^\d+]/g, '');
  return digits.length <= 4
    ? DOT.repeat(digits.length)
    : DOT.repeat(digits.length - 4) + digits.slice(-4);
};

interface DonorRow {
  id: string;
  tenant_id: string;
  donor_number: string;
  full_name: string;
  dob: string;
  sex: 'female' | 'male' | 'other';
  phone: string | null;
  blood_group: BloodDonor['bloodGroup'];
  deferred_until: Date | null;
  deferred_permanent: boolean;
  deferral_reason: string | null;
  version: number;
  last_donated_at: Date | null;
  deferred: boolean;
}

const SELECT = `select x.id, x.tenant_id, x.donor_number, x.full_name, x.date_of_birth::text as dob,
       x.sex, x.phone, x.blood_group, x.deferred_until, x.deferred_permanent, x.deferral_reason,
       x.version, x.created_at,
       lc.last_at as last_donated_at,
       (x.deferred_permanent or coalesce(x.deferred_until > now(), false)) as deferred
  from blood_donors x
  left join lateral (select max(c.collected_at) as last_at from blood_collections c where c.donor_id = x.id) lc on true`;

const common = (row: DonorRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  donorNumber: row.donor_number,
  sex: row.sex,
  bloodGroup: row.blood_group,
  status: row.deferred ? ('deferred' as const) : ('active' as const),
  ...(row.deferred_until === null ? {} : { deferredUntil: iso(row.deferred_until) }),
  deferredPermanent: row.deferred_permanent,
  ...(row.last_donated_at === null ? {} : { lastDonatedAt: iso(row.last_donated_at) }),
  version: row.version,
});

const summary = (row: DonorRow): BloodDonorSummary => ({
  ...common(row),
  maskedName: maskName(row.full_name),
  ...(row.phone === null ? {} : { maskedPhone: maskPhone(row.phone) }),
});

async function findDonor(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<DonorRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<DonorRow>(
    `${SELECT} where x.id = $1 ${lock ? 'for update of x' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const notFound = () => new HttpError(404, 'blood_donor_not_found', 'No such donor');

async function collectionsOf(client: pg.ClientBase, donorId: string): Promise<BloodCollection[]> {
  const { rows } = await client.query<{
    id: string;
    collected_at: Date;
    volume_ml: number;
    unit_ids: string[];
  }>(
    `select c.id, c.collected_at, c.volume_ml,
            coalesce(array_agg(u.id order by u.unit_number) filter (where u.id is not null), '{}') as unit_ids
     from blood_collections c left join blood_units u on u.collection_id = c.id
     where c.donor_id = $1 group by c.id order by c.collected_at desc, c.id desc limit 50`,
    [donorId],
  );
  return rows.map((row) => ({
    id: row.id,
    donorId,
    collectedAt: iso(row.collected_at),
    volumeMl: row.volume_ml,
    unitIds: row.unit_ids,
  }));
}

const likeEscape = (term: string) => term.replace(/[\\%_]/g, (char) => `\\${char}`);

export const bloodDonorRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/blood/donors',
    {
      config: {
        permissions: [MANAGE],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'registerBloodDonor',
        tags: ['bloodbank'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Registers a blood donor: a person of the blood bank, not a patient. Only the name, birth date, sex, blood group and an optional phone are kept. The donor is aged 18 to 65 (422 `donor_age`); the number is made by the server. The Idempotency-Key header is required. Audited; emits `blood.donor_registered`. Requires bloodDonor:manage.',
        body: BloodDonorCreate,
        response: { 201: ref(BloodDonor), ...errors(400, 401, 403, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      const age = ageOn(body.dateOfBirth, new Date());
      if (age < DONOR_MIN_AGE || age > DONOR_MAX_AGE) {
        throw new HttpError(
          422,
          'donor_age',
          `A donor is aged ${DONOR_MIN_AGE} to ${DONOR_MAX_AGE}`,
        );
      }
      const client = request.txClient;
      let id: string | undefined;
      for (let attempt = 0; attempt < 5 && id === undefined; attempt += 1) {
        const number = `D${randomBytes(5).toString('hex').toUpperCase().slice(0, 8)}`;
        await client.query('savepoint donor_number');
        try {
          const { rows } = await client.query<{ id: string }>(
            `insert into blood_donors (donor_number, full_name, date_of_birth, sex, phone, blood_group, created_by)
             values ($1, $2, $3, $4, $5, $6, $7) returning id`,
            [
              number,
              body.fullName.trim(),
              body.dateOfBirth,
              body.sex,
              body.phone?.trim() ?? null,
              body.bloodGroup,
              userIdOf(request),
            ],
          );
          id = (rows[0] as { id: string }).id;
        } catch (error) {
          await client.query('rollback to savepoint donor_number');
          if (!isCode(error, '23505', 'blood_donors_number')) throw error;
        }
      }
      if (id === undefined) throw new HttpError(503, 'donor_number_busy', 'Try again');
      request.audit('create', 'blood_donor', id);
      await request.emit('blood.donor_registered', id, { bloodGroup: body.bloodGroup });
      const row = (await findDonor(client, id)) as DonorRow;
      return reply.status(201).send({
        ...common(row),
        fullName: row.full_name,
        dateOfBirth: row.dob,
        ...(row.phone === null ? {} : { phone: row.phone }),
        collections: [],
      });
    },
  );

  app.post(
    '/blood/donors/search',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'searchBloodDonors',
        tags: ['bloodbank'],
        description:
          'Donors, newest first, with the name and phone masked. `q` matches part of the name or the donor number. What is searched for travels in the body, never in a query string, and the API does not log the body. It reads data only. Requires bloodDonor:read.',
        body: ref(BloodDonorSearch),
        response: { 200: ref(BloodDonorPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const body = request.body as BloodDonorSearch;
      const params: unknown[] = [];
      const where: string[] = [];
      const q = searchTerm(body.q);
      if (q) {
        params.push(`%${likeEscape(q)}%`);
        where.push(
          `(x.full_name ilike $${params.length} escape '\\' or x.donor_number ilike $${params.length} escape '\\')`,
        );
      }
      if (body.bloodGroup) {
        params.push(body.bloodGroup);
        where.push(`x.blood_group = $${params.length}`);
      }
      if (body.status === 'deferred') {
        where.push('(x.deferred_permanent or coalesce(x.deferred_until > now(), false))');
      } else if (body.status === 'active') {
        where.push('not (x.deferred_permanent or coalesce(x.deferred_until > now(), false))');
      }
      const page = await selectPage<DonorRow>(request.txClient, {
        select: SELECT,
        where,
        params,
        order: 'x.created_at',
        desc: true,
        cursor: body.cursor,
        limit: body.limit ?? DEFAULT_PAGE_SIZE,
      });
      return { items: page.rows.map(summary), nextCursor: page.nextCursor };
    },
  );

  app.get(
    '/blood/donors/:donorId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getBloodDonor',
        tags: ['bloodbank'],
        description:
          'A donor in full, with the collections made, newest first. Audited as a read. 404 `blood_donor_not_found`. Requires bloodDonor:read.',
        params: BloodDonorParams,
        response: { 200: ref(BloodDonor), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await findDonor(request.txClient, request.params.donorId);
      if (!row) throw notFound();
      request.audit('read', 'blood_donor', row.id);
      return {
        ...common(row),
        fullName: row.full_name,
        dateOfBirth: row.dob,
        ...(row.phone === null ? {} : { phone: row.phone }),
        ...(row.deferral_reason === null ? {} : { deferralReason: row.deferral_reason }),
        collections: await collectionsOf(request.txClient, row.id),
      };
    },
  );

  app.patch(
    '/blood/donors/:donorId',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'updateBloodDonor',
        tags: ['bloodbank'],
        description:
          "Corrects a donor's name, date of birth, sex or phone (null clears the phone); the blood group and number never change. Only the fields sent change. `expectedVersion` is the version the caller read, else 409 `conflict` and nothing changes. The age rule of registration holds for a new date of birth (422 `donor_age`). Audited. Requires bloodDonor:manage and bloodDonor:read.",
        params: BloodDonorParams,
        body: BloodDonorUpdate,
        response: { 200: ref(BloodDonor), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const { expectedVersion, ...sent } = request.body;
      const probe = await findDonor(client, request.params.donorId);
      if (!probe) throw notFound();
      const row = (await findDonor(client, probe.id, true)) as DonorRow;
      if (row.version !== expectedVersion) {
        throw new HttpError(409, 'conflict', 'The donor has changed since it was read');
      }
      if (sent.dateOfBirth !== undefined) {
        const age = ageOn(sent.dateOfBirth, new Date());
        if (age < DONOR_MIN_AGE || age > DONOR_MAX_AGE) {
          throw new HttpError(
            422,
            'donor_age',
            `A donor is aged ${DONOR_MIN_AGE} to ${DONOR_MAX_AGE}`,
          );
        }
      }
      const next = {
        fullName: sent.fullName?.trim() ?? row.full_name,
        dateOfBirth: sent.dateOfBirth ?? row.dob,
        sex: sent.sex ?? row.sex,
        phone: sent.phone === undefined ? row.phone : (sent.phone?.trim() ?? null),
      };
      const changed =
        next.fullName !== row.full_name ||
        next.dateOfBirth !== row.dob ||
        next.sex !== row.sex ||
        next.phone !== row.phone;
      if (changed) {
        await client.query(
          'update blood_donors set full_name = $2, date_of_birth = $3, sex = $4, phone = $5 where id = $1',
          [row.id, next.fullName, next.dateOfBirth, next.sex, next.phone],
        );
        request.audit('update', 'blood_donor', row.id);
      }
      const fresh = (await findDonor(client, row.id)) as DonorRow;
      return {
        ...common(fresh),
        fullName: fresh.full_name,
        dateOfBirth: fresh.dob,
        ...(fresh.phone === null ? {} : { phone: fresh.phone }),
        ...(fresh.deferral_reason === null ? {} : { deferralReason: fresh.deferral_reason }),
        collections: await collectionsOf(client, fresh.id),
      };
    },
  );

  app.post(
    '/blood/donors/:donorId/defer',
    {
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'deferBloodDonor',
        tags: ['bloodbank'],
        headers: IdempotencyHeaders,
        description:
          'Defers a donor from giving blood, until a date (`until`, in the future, else 422 `invalid_period`) or for good when it is left out. A deferral is never shortened: a later date replaces an earlier one, and a permanent one is final. Audited; emits `blood.donor_deferred`. Requires bloodDonor:manage.',
        params: BloodDonorParams,
        body: BloodDonorDefer,
        response: { 200: ref(BloodDonor), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const probe = await findDonor(client, request.params.donorId);
      if (!probe) throw notFound();
      const row = (await findDonor(client, probe.id, true)) as DonorRow;
      const body = request.body;
      if (row.deferred_permanent) {
        throw new HttpError(409, 'already_deferred', 'The donor is deferred for good');
      }
      const until = body.until === undefined ? null : new Date(body.until);
      if (until !== null && !(until.getTime() > Date.now())) {
        throw new HttpError(422, 'invalid_period', 'A deferral ends in the future');
      }
      if (until !== null && row.deferred_until !== null && until <= row.deferred_until) {
        throw new HttpError(409, 'already_deferred', 'The donor is deferred for longer already');
      }
      await client.query(
        `update blood_donors set deferred_until = $2, deferred_permanent = $3, deferral_reason = $4
         where id = $1`,
        [row.id, until, until === null, body.reason.trim()],
      );
      request.audit('update', 'blood_donor', row.id);
      await request.emit('blood.donor_deferred', row.id, {
        permanent: until === null,
        until: until === null ? null : until.toISOString(),
      });
      const fresh = (await findDonor(client, row.id)) as DonorRow;
      return {
        ...common(fresh),
        fullName: fresh.full_name,
        dateOfBirth: fresh.dob,
        ...(fresh.phone === null ? {} : { phone: fresh.phone }),
        ...(fresh.deferral_reason === null ? {} : { deferralReason: fresh.deferral_reason }),
        collections: await collectionsOf(client, fresh.id),
      };
    },
  );

  app.post(
    '/blood/collections',
    {
      config: {
        permissions: [MANAGE],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'recordBloodCollection',
        tags: ['bloodbank'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a donation and the units made of it, each in status `collected` with the donor’s blood group and awaiting testing and screening. The donor is not deferred (422 `donor_deferred`), is aged 18 to 65 on the day (422 `donor_age`) and last gave at least 90 days before (422 `donation_too_soon`). The collection is not in the future and every unit expires after it (422 `invalid_period`); a unit number is unique (409 `duplicate_unit`). The Idempotency-Key header is required. Audited; emits `blood.collection_recorded` and `blood.unit_registered` for each unit. Requires bloodDonor:manage.',
        body: BloodCollectionCreate,
        response: { 201: ref(BloodCollection), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await findDonor(client, body.donorId);
      if (!probe) throw notFound();
      // The donor row is locked, so two collections for one donor are made one after the other.
      const donor = (await findDonor(client, probe.id, true)) as DonorRow;
      const collected = body.collectedAt === undefined ? new Date() : new Date(body.collectedAt);
      if (collected.getTime() > Date.now() + 5 * 60 * 1000) {
        throw new HttpError(422, 'invalid_period', 'A donation is not in the future');
      }
      if (body.units.some((unit) => !(new Date(unit.expiresAt) > collected))) {
        throw new HttpError(422, 'invalid_period', 'A unit expires after it is collected');
      }
      if (donor.deferred) throw new HttpError(422, 'donor_deferred', 'The donor is deferred');
      const age = ageOn(donor.dob, collected);
      if (age < DONOR_MIN_AGE || age > DONOR_MAX_AGE) {
        throw new HttpError(
          422,
          'donor_age',
          `A donor is aged ${DONOR_MIN_AGE} to ${DONOR_MAX_AGE}`,
        );
      }
      if (
        donor.last_donated_at !== null &&
        collected.getTime() < donor.last_donated_at.getTime() + DONATION_INTERVAL_DAYS * DAY
      ) {
        throw new HttpError(
          422,
          'donation_too_soon',
          `A donor gives again after ${DONATION_INTERVAL_DAYS} days`,
        );
      }
      const actor = userIdOf(request);
      const { rows } = await client.query<{ id: string }>(
        `insert into blood_collections (donor_id, collected_at, volume_ml, collected_by)
         values ($1, $2, $3, $4) returning id`,
        [donor.id, collected, body.volumeMl, actor],
      );
      const collectionId = (rows[0] as { id: string }).id;
      const unitIds: string[] = [];
      for (const unit of body.units) {
        try {
          const made = await client.query<{ id: string }>(
            `insert into blood_units (unit_number, blood_group, component, volume_ml, collected_at,
                                      expires_at, created_by, donor_id, collection_id)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
            [
              unit.unitNumber.trim(),
              donor.blood_group,
              unit.component,
              unit.volumeMl,
              collected,
              new Date(unit.expiresAt),
              actor,
              donor.id,
              collectionId,
            ],
          );
          unitIds.push((made.rows[0] as { id: string }).id);
        } catch (error) {
          if (isCode(error, '23505', 'blood_units_number')) {
            throw new HttpError(409, 'duplicate_unit', 'A unit with that number exists');
          }
          throw error;
        }
      }
      for (const unitId of unitIds) {
        await client.query(
          `insert into blood_unit_events (blood_unit_id, from_status, to_status, actor_id)
           values ($1, null, 'collected', $2)`,
          [unitId, actor],
        );
        await request.emit('blood.unit_registered', unitId, {
          bloodGroup: donor.blood_group,
          component: body.units[unitIds.indexOf(unitId)]?.component ?? null,
        });
      }
      request.audit('create', 'blood_collection', collectionId);
      await request.emit('blood.collection_recorded', collectionId, {
        donorId: donor.id,
        units: unitIds.length,
      });
      return reply.status(201).send({
        id: collectionId,
        donorId: donor.id,
        collectedAt: collected.toISOString(),
        volumeMl: body.volumeMl,
        unitIds,
      });
    },
  );
};
