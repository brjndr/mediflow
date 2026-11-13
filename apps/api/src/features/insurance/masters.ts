import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { searchTerm } from '../../core/http/text.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { todayAtHospital } from '../../core/tenancy/today.js';
import {
  AgreementParams,
  Payer,
  PayerCreate,
  PayerDetail,
  PayerListQuery,
  PayerPage,
  PayerParams,
  PayerPlan,
  PayerPlanUpdate,
  PayerPlanWrite,
  PayerUpdate,
  PlanParams,
  RateAgreement,
  RateAgreementCreate,
  RateAgreementEnd,
} from './schemas.js';
import { isCode, isUuid, tidy, userIdOf } from './util.js';

const FEATURE = 'insurance';
const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// --- payers ------------------------------------------------------------------------------------

interface PayerRow {
  id: string;
  tenant_id: string;
  kind: Payer['kind'];
  code: string;
  name: string;
  contact_name: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  archived: boolean;
  version: number;
  plan_count: number;
  name_lower: string;
}
const PAYERS = `select p.id, p.tenant_id, p.kind, p.code, p.name, p.name_lower, p.contact_name,
       p.phone, p.email, p.address, p.archived, p.version,
       (select count(*)::int from payer_plans l
         where l.tenant_id = p.tenant_id and l.payer_id = p.id and not l.archived) as plan_count
  from payers p`;
const payerView = (row: PayerRow): Payer => ({
  id: row.id,
  tenantId: row.tenant_id,
  kind: row.kind,
  code: row.code,
  name: row.name,
  ...(row.contact_name === null ? {} : { contactName: row.contact_name }),
  ...(row.phone === null ? {} : { phone: row.phone }),
  ...(row.email === null ? {} : { email: row.email }),
  ...(row.address === null ? {} : { address: row.address }),
  planCount: row.plan_count,
  archived: row.archived,
  version: row.version,
});

async function findPayer(
  client: pg.ClientBase,
  id: string,
  lock = false,
): Promise<PayerRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<PayerRow>(
    `${PAYERS} where p.id = $1 ${lock ? 'for update of p' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}
const payerGone = () => new HttpError(404, 'payer_not_found', 'No such organisation');
const versionConflict = () =>
  new HttpError(409, 'version_conflict', 'It has changed since it was read');

// --- plans -------------------------------------------------------------------------------------

interface PlanRow {
  id: string;
  payer_id: string;
  code: string;
  name: string;
  coverage_mode: PayerPlan['coverageMode'];
  copay_percent: number;
  sum_insured_minor: string | null;
  room_rent_limit_minor: string | null;
  pre_auth_required: boolean;
  min_age: number | null;
  max_age: number | null;
  waiting_period_days: number | null;
  archived: boolean;
  version: number;
}
const PLANS = `select id, payer_id, code, name, coverage_mode, copay_percent, sum_insured_minor,
       room_rent_limit_minor, pre_auth_required, min_age, max_age, waiting_period_days, archived,
       version from payer_plans`;

async function plansOf(
  client: pg.ClientBase,
  where: string,
  params: unknown[],
): Promise<PayerPlan[]> {
  const { rows } = await client.query<PlanRow>(
    `${PLANS} where ${where} order by name_lower, id`,
    params,
  );
  if (rows.length === 0) return [];
  const listed = await client.query<{
    plan_id: string;
    service_id: string;
    name: string;
    limit_minor: string | null;
  }>(
    `select x.plan_id, x.service_id, s.name, x.limit_minor
       from payer_plan_services x
       join services s on s.tenant_id = x.tenant_id and s.id = x.service_id
      where x.plan_id = any($1::uuid[])
      order by s.name_lower, x.service_id`,
    [rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    payerId: row.payer_id,
    code: row.code,
    name: row.name,
    coverageMode: row.coverage_mode,
    copayPercent: row.copay_percent,
    ...(row.sum_insured_minor === null ? {} : { sumInsuredMinor: Number(row.sum_insured_minor) }),
    ...(row.room_rent_limit_minor === null
      ? {}
      : { roomRentLimitMinor: Number(row.room_rent_limit_minor) }),
    preAuthRequired: row.pre_auth_required,
    ...(row.min_age === null ? {} : { minAge: row.min_age }),
    ...(row.max_age === null ? {} : { maxAge: row.max_age }),
    ...(row.waiting_period_days === null ? {} : { waitingPeriodDays: row.waiting_period_days }),
    services: listed.rows
      .filter((one) => one.plan_id === row.id)
      .map((one) => ({
        serviceId: one.service_id,
        serviceName: one.name,
        ...(one.limit_minor === null ? {} : { limitMinor: Number(one.limit_minor) }),
      })),
    archived: row.archived,
    version: row.version,
  }));
}

/** 422 `unknown_service` unless each id is a service of this hospital, and each is listed once. */
async function checkServices(client: pg.ClientBase, ids: string[]): Promise<void> {
  if (new Set(ids).size !== ids.length) {
    throw new HttpError(422, 'duplicate_service', 'A service is listed twice');
  }
  if (ids.length === 0) return;
  if (!ids.every(isUuid)) throw new HttpError(422, 'unknown_service', 'No such service');
  const { rows } = await client.query<{ n: number }>(
    'select count(*)::int as n from services where id = any($1::uuid[])',
    [ids],
  );
  if ((rows[0]?.n ?? 0) !== ids.length) {
    throw new HttpError(422, 'unknown_service', 'No such service');
  }
}

async function writeListed(
  client: pg.ClientBase,
  planId: string,
  services: { serviceId: string; limitMinor?: number | undefined }[],
): Promise<void> {
  await client.query('delete from payer_plan_services where plan_id = $1', [planId]);
  for (const one of services) {
    await client.query(
      'insert into payer_plan_services (plan_id, service_id, limit_minor) values ($1, $2, $3)',
      [planId, one.serviceId, one.limitMinor ?? null],
    );
  }
}

function checkAges(min: number | null | undefined, max: number | null | undefined) {
  if (min != null && max != null && min > max) {
    throw new HttpError(422, 'invalid_ages', 'The youngest age is above the oldest');
  }
}

// --- rate agreements ---------------------------------------------------------------------------

interface AgreementRow {
  id: string;
  payer_id: string;
  name: string;
  effective_from: string;
  effective_to: string | null;
  discount_bp: number;
  version: number;
}
const AGREEMENTS = `select id, payer_id, name, effective_from::text, effective_to::text, discount_bp,
       version from rate_agreements`;

async function agreementsOf(
  client: pg.ClientBase,
  where: string,
  params: unknown[],
): Promise<RateAgreement[]> {
  const { rows } = await client.query<AgreementRow>(
    `${AGREEMENTS} where ${where} order by effective_from desc, id`,
    params,
  );
  if (rows.length === 0) return [];
  const rates = await client.query<{
    agreement_id: string;
    service_id: string;
    name: string;
    rate_minor: string;
  }>(
    `select x.agreement_id, x.service_id, s.name, x.rate_minor
       from rate_agreement_rates x
       join services s on s.tenant_id = x.tenant_id and s.id = x.service_id
      where x.agreement_id = any($1::uuid[])
      order by s.name_lower, x.service_id`,
    [rows.map((row) => row.id)],
  );
  return rows.map((row) => ({
    id: row.id,
    payerId: row.payer_id,
    name: row.name,
    effectiveFrom: row.effective_from,
    ...(row.effective_to === null ? {} : { effectiveTo: row.effective_to }),
    discountBp: row.discount_bp,
    rates: rates.rows
      .filter((one) => one.agreement_id === row.id)
      .map((one) => ({
        serviceId: one.service_id,
        serviceName: one.name,
        rateMinor: Number(one.rate_minor),
      })),
    version: row.version,
  }));
}

// --- cursor ------------------------------------------------------------------------------------

function decodeCursor(cursor: string): { n: string; i: string } {
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
const likeEscape = (term: string) => term.replace(/[\\%_]/g, (char) => `\\${char}`);

export const mastersRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/payers',
    {
      config: { permissions: ['payer:read'], feature: FEATURE },
      schema: {
        operationId: 'listPayers',
        tags: ['insurance'],
        description:
          'The hospital’s insurers, TPAs and corporates by name, archived or not (`archived`, default not). `q` matches the name or code. Cursor paged; `total` counts the filter. Requires payer:read.',
        querystring: PayerListQuery,
        response: { 200: ref(PayerPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [q.archived === true];
      const where = ['p.archived = $1'];
      if (q.kind) {
        params.push(q.kind);
        where.push(`p.kind = $${params.length}`);
      }
      const term = searchTerm(q.q);
      if (term) {
        params.push(`%${likeEscape(term.toLowerCase())}%`);
        where.push(`(p.name_lower like $${params.length} or p.code_lower like $${params.length})`);
      }
      const totalRow = await request.txClient.query<{ n: number }>(
        `select count(*)::int as n from payers p where ${where.join(' and ')}`,
        params,
      );
      if (q.cursor) {
        const cursor = decodeCursor(q.cursor);
        params.push(cursor.n, cursor.i);
        where.push(`(p.name_lower, p.id) > ($${params.length - 1}, $${params.length}::uuid)`);
      }
      const limit = q.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await request.txClient.query<PayerRow>(
        `${PAYERS} where ${where.join(' and ')} order by p.name_lower, p.id limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      const last = page[page.length - 1];
      return {
        items: page.map(payerView),
        nextCursor:
          rows.length > limit && last
            ? Buffer.from(JSON.stringify({ n: last.name_lower, i: last.id })).toString('base64url')
            : null,
        total: totalRow.rows[0]?.n ?? 0,
      };
    },
  );

  app.post(
    '/payers',
    {
      config: {
        permissions: ['payer:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createPayer',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds an insurer, TPA or corporate. The code is unique in the hospital whatever its capitals (409 `duplicate_code`) and never changes. Audited. Requires payer:manage.',
        body: PayerCreate,
        response: { 201: ref(Payer), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body;
      if (!CODE.test(body.code.trim())) {
        throw new HttpError(400, 'validation_failed', 'The code is not valid');
      }
      try {
        const { rows } = await request.txClient.query<{ id: string }>(
          `insert into payers (kind, code, name, contact_name, phone, email, address, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [
            body.kind,
            body.code.trim(),
            tidy(body.name),
            body.contactName === undefined ? null : tidy(body.contactName),
            body.phone === undefined ? null : tidy(body.phone),
            body.email === undefined ? null : tidy(body.email),
            body.address === undefined ? null : tidy(body.address),
            userIdOf(request),
          ],
        );
        const id = (rows[0] as { id: string }).id;
        request.audit('create', 'payer', id);
        return reply
          .status(201)
          .send(payerView((await findPayer(request.txClient, id)) as PayerRow));
      } catch (error) {
        if (isCode(error, '23505', 'payers_code_taken')) {
          throw new HttpError(409, 'duplicate_code', 'That code is used already');
        }
        throw error;
      }
    },
  );

  app.get(
    '/payers/:payerId',
    {
      config: { permissions: ['payer:read'], feature: FEATURE },
      schema: {
        operationId: 'getPayer',
        tags: ['insurance'],
        description:
          'An organisation with its plans (archived ones too) and rate agreements, newest first. Requires payer:read.',
        params: PayerParams,
        response: { 200: ref(PayerDetail), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const payer = await findPayer(request.txClient, request.params.payerId);
      if (!payer) throw payerGone();
      return {
        payer: payerView(payer),
        plans: await plansOf(request.txClient, 'payer_id = $1', [payer.id]),
        agreements: await agreementsOf(request.txClient, 'payer_id = $1', [payer.id]),
      };
    },
  );

  app.patch(
    '/payers/:payerId',
    {
      config: { permissions: ['payer:manage'], feature: FEATURE },
      schema: {
        operationId: 'updatePayer',
        tags: ['insurance'],
        description:
          'Changes the fields sent, from the `version` the edit started from (409 `version_conflict`). A contact field sent as null is cleared. Archiving hides the organisation from the list and from new plans, agreements and policies. Audited. Requires payer:manage.',
        params: PayerParams,
        body: PayerUpdate,
        response: { 200: ref(Payer), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await findPayer(client, request.params.payerId);
      if (!probe) throw payerGone();
      const row = (await findPayer(client, probe.id, true)) as PayerRow;
      if (row.version !== body.version) throw versionConflict();
      const sets: string[] = [];
      const params: unknown[] = [row.id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (body.name !== undefined) set('name', tidy(body.name));
      for (const [key, column] of [
        ['contactName', 'contact_name'],
        ['phone', 'phone'],
        ['email', 'email'],
        ['address', 'address'],
      ] as const) {
        const value = body[key] as string | null | undefined;
        if (value !== undefined) set(column, value === null ? null : tidy(value));
      }
      if (body.archived !== undefined) set('archived', body.archived);
      if (sets.length > 0) {
        await client.query(`update payers set ${sets.join(', ')} where id = $1`, params);
      }
      request.audit('update', 'payer', row.id);
      return payerView((await findPayer(client, row.id)) as PayerRow);
    },
  );

  app.post(
    '/payers/:payerId/plans',
    {
      config: {
        permissions: ['payer:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createPayerPlan',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds a plan: the patient’s share, limits, eligibility rules and the services covered or left out. The code is unique within the organisation (409 `duplicate_code`); an archived organisation takes none (409 `payer_archived`); a service that is not the hospital’s is 422 `unknown_service`. Audited. Requires payer:manage.',
        params: PayerParams,
        body: PayerPlanWrite,
        response: { 201: ref(PayerPlan), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      const payer = await findPayer(client, request.params.payerId);
      if (!payer) throw payerGone();
      if (!CODE.test(body.code.trim())) {
        throw new HttpError(400, 'validation_failed', 'The code is not valid');
      }
      if (payer.archived)
        throw new HttpError(409, 'payer_archived', 'The organisation is archived');
      checkAges(body.minAge, body.maxAge);
      await checkServices(
        client,
        body.services.map((one) => one.serviceId),
      );
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into payer_plans (payer_id, code, name, coverage_mode, copay_percent,
             sum_insured_minor, room_rent_limit_minor, pre_auth_required, min_age, max_age,
             waiting_period_days, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id`,
          [
            payer.id,
            body.code.trim(),
            tidy(body.name),
            body.coverageMode,
            body.copayPercent,
            body.sumInsuredMinor ?? null,
            body.roomRentLimitMinor ?? null,
            body.preAuthRequired,
            body.minAge ?? null,
            body.maxAge ?? null,
            body.waitingPeriodDays ?? null,
            userIdOf(request),
          ],
        );
        const id = (rows[0] as { id: string }).id;
        await writeListed(client, id, body.services);
        request.audit('create', 'payer_plan', id);
        const [plan] = await plansOf(client, 'id = $1', [id]);
        return reply.status(201).send(plan as PayerPlan);
      } catch (error) {
        if (isCode(error, '23505', 'payer_plans_code_taken')) {
          throw new HttpError(409, 'duplicate_code', 'That code is used already');
        }
        throw error;
      }
    },
  );

  app.patch(
    '/payer-plans/:planId',
    {
      config: { permissions: ['payer:manage'], feature: FEATURE },
      schema: {
        operationId: 'updatePayerPlan',
        tags: ['insurance'],
        description:
          'Replaces the plan’s terms as sent, from the `version` the edit started from (409 `version_conflict`). When any term or the services are sent, a limit or age left out is removed. Archived alone changes nothing else. The code does not change. Audited. Requires payer:manage.',
        params: PlanParams,
        body: PayerPlanUpdate,
        response: { 200: ref(PayerPlan), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const id = request.params.planId;
      const gone = () => new HttpError(404, 'plan_not_found', 'No such plan');
      if (!isUuid(id)) throw gone();
      const locked = await client.query<PlanRow>(`${PLANS} where id = $1 for update`, [id]);
      const row = locked.rows[0];
      if (!row) throw gone();
      if (row.version !== body.version) throw versionConflict();
      const termsSent =
        body.name !== undefined ||
        body.coverageMode !== undefined ||
        body.copayPercent !== undefined ||
        body.preAuthRequired !== undefined ||
        body.sumInsuredMinor !== undefined ||
        body.roomRentLimitMinor !== undefined ||
        body.minAge !== undefined ||
        body.maxAge !== undefined ||
        body.waitingPeriodDays !== undefined;
      const sets: string[] = [];
      const params: unknown[] = [row.id];
      const set = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (body.name !== undefined) set('name', tidy(body.name));
      if (body.coverageMode !== undefined) set('coverage_mode', body.coverageMode);
      if (body.copayPercent !== undefined) set('copay_percent', body.copayPercent);
      if (body.preAuthRequired !== undefined) set('pre_auth_required', body.preAuthRequired);
      if (termsSent) {
        set('sum_insured_minor', body.sumInsuredMinor ?? null);
        set('room_rent_limit_minor', body.roomRentLimitMinor ?? null);
        set('min_age', body.minAge ?? null);
        set('max_age', body.maxAge ?? null);
        set('waiting_period_days', body.waitingPeriodDays ?? null);
        checkAges(body.minAge, body.maxAge);
      }
      if (body.archived !== undefined) set('archived', body.archived);
      if (body.services !== undefined) {
        await checkServices(
          client,
          body.services.map((one) => one.serviceId),
        );
        await writeListed(client, row.id, body.services);
      }
      if (sets.length > 0) {
        await client.query(`update payer_plans set ${sets.join(', ')} where id = $1`, params);
      } else if (body.services !== undefined) {
        // Only the services changed: the plan still moves to a new version.
        await client.query('update payer_plans set name = name where id = $1', [row.id]);
      }
      request.audit('update', 'payer_plan', row.id);
      const [plan] = await plansOf(client, 'id = $1', [row.id]);
      return plan as PayerPlan;
    },
  );

  app.post(
    '/payers/:payerId/rate-agreements',
    {
      config: {
        permissions: ['payer:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createRateAgreement',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds an agreement: a discount on the price list and agreed rates that replace the list price of a service, from a first day to an optional last day. It cannot start in the past, on the hospital’s clock (422 `starts_in_past`), nor overlap another of the organisation, a closed range with no last day being open-ended (409 `agreement_overlap`). It is never edited, only ended. Audited. Requires payer:manage.',
        params: PayerParams,
        body: RateAgreementCreate,
        response: { 201: ref(RateAgreement), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      const payer = await findPayer(client, request.params.payerId);
      if (!payer) throw payerGone();
      if (body.effectiveTo !== undefined && body.effectiveTo < body.effectiveFrom) {
        throw new HttpError(400, 'validation_failed', 'The last day is before the first');
      }
      if (payer.archived)
        throw new HttpError(409, 'payer_archived', 'The organisation is archived');
      if (body.effectiveFrom < (await todayAtHospital(client))) {
        throw new HttpError(422, 'starts_in_past', 'An agreement cannot start in the past');
      }
      await checkServices(
        client,
        body.rates.map((one) => one.serviceId),
      );
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into rate_agreements (payer_id, name, effective_from, effective_to, discount_bp,
             created_by) values ($1, $2, $3, $4, $5, $6) returning id`,
          [
            payer.id,
            tidy(body.name),
            body.effectiveFrom,
            body.effectiveTo ?? null,
            body.discountBp,
            userIdOf(request),
          ],
        );
        const id = (rows[0] as { id: string }).id;
        for (const rate of body.rates) {
          await client.query(
            'insert into rate_agreement_rates (agreement_id, service_id, rate_minor) values ($1, $2, $3)',
            [id, rate.serviceId, rate.rateMinor],
          );
        }
        request.audit('create', 'rate_agreement', id);
        const [agreement] = await agreementsOf(client, 'id = $1', [id]);
        return reply.status(201).send(agreement as RateAgreement);
      } catch (error) {
        if (isCode(error, '23P01', 'rate_agreements_no_overlap')) {
          throw new HttpError(409, 'agreement_overlap', 'It overlaps another agreement');
        }
        throw error;
      }
    },
  );

  app.patch(
    '/rate-agreements/:agreementId',
    {
      config: { permissions: ['payer:manage'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'endRateAgreement',
        tags: ['insurance'],
        headers: IdempotencyHeaders,
        description:
          'Ends an agreement on a last day (not before its first), or, with null, leaves it open-ended. Nothing else about an agreement changes. A last day that runs into the next agreement is 409 `agreement_overlap`; a stale `version` is 409 `version_conflict`. Audited. Requires payer:manage.',
        params: AgreementParams,
        body: RateAgreementEnd,
        response: { 200: ref(RateAgreement), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const id = request.params.agreementId;
      const gone = () => new HttpError(404, 'agreement_not_found', 'No such agreement');
      if (!isUuid(id)) throw gone();
      const locked = await client.query<AgreementRow>(`${AGREEMENTS} where id = $1 for update`, [
        id,
      ]);
      const row = locked.rows[0];
      if (!row) throw gone();
      if (row.version !== body.version) throw versionConflict();
      const to = body.effectiveTo ?? null;
      if (to !== null && to < row.effective_from) {
        throw new HttpError(422, 'validation_failed', 'The last day is before the first');
      }
      try {
        await client.query('update rate_agreements set effective_to = $2 where id = $1', [
          row.id,
          to,
        ]);
      } catch (error) {
        if (isCode(error, '23P01', 'rate_agreements_no_overlap')) {
          throw new HttpError(409, 'agreement_overlap', 'It overlaps another agreement');
        }
        throw error;
      }
      request.audit('update', 'rate_agreement', row.id);
      const [agreement] = await agreementsOf(client, 'id = $1', [row.id]);
      return agreement as RateAgreement;
    },
  );
};
