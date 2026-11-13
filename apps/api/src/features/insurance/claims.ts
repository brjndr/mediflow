import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import type { Claim } from './claim-schemas.js';
import {
  ClaimAction,
  ClaimAging,
  ClaimCreate,
  ClaimDetail,
  ClaimListQuery,
  ClaimPage,
  ClaimParams,
  type ClaimActionKind,
  type ClaimEvent,
  type ClaimStatus,
} from './claim-schemas.js';
import { EncounterParams } from './schemas.js';
import { computeSplit, visitPatient } from './split.js';
import { isCode, isUuid, requirePatient, tidy, userIdOf } from './util.js';

const FEATURE = 'insurance';

/**
 * The claim state machine: what can be done in each state and where it leads. A reply answers a
 * query and puts the claim back to the payer; a rejected claim and a settled claim that was
 * short-paid can be written off; every other state ends the claim.
 */
export const CLAIM_TRANSITIONS: Record<
  ClaimStatus,
  Partial<Record<ClaimActionKind, ClaimStatus>>
> = {
  draft: { submit: 'submitted', cancel: 'cancelled' },
  submitted: { raise_query: 'query', approve: 'approved', reject: 'rejected' },
  query: { reply: 'submitted', cancel: 'cancelled' },
  approved: { settle: 'settled' },
  rejected: { write_off: 'written_off' },
  settled: { write_off: 'written_off' },
  written_off: {},
  cancelled: {},
};

/** Actions that must say why or what was asked. */
const NEEDS_NOTE: ClaimActionKind[] = ['raise_query', 'reply', 'reject', 'write_off'];

/** Claimed less received and written off, for a claim in play; nothing before or after. */
const OUTSTANDING_SQL = `case when c.status in ('draft', 'cancelled', 'written_off') then 0
       else greatest(c.claimed_minor - c.received_minor - c.written_off_minor, 0) end`;

interface ClaimRow {
  id: string;
  seq: number;
  patient_id: string;
  encounter_id: string;
  policy_id: string;
  payer_id: string;
  payer_name: string;
  policy_number: string;
  claimed_minor: string;
  approved_minor: string | null;
  received_minor: string;
  written_off_minor: string;
  outstanding_minor: string;
  status: ClaimStatus;
  reference_number: string | null;
  open_query: string | null;
  documents: string[];
  created_at: Date;
  submitted_at: Date | null;
  decided_at: Date | null;
  version: number;
}

const CLAIMS = `select c.id, c.seq, c.patient_id, c.encounter_id, c.policy_id, c.payer_id,
       py.name as payer_name, c.policy_number, c.claimed_minor, c.approved_minor,
       c.received_minor, c.written_off_minor, (${OUTSTANDING_SQL}) as outstanding_minor, c.status,
       c.reference_number, c.open_query, c.documents, c.created_at, c.submitted_at, c.decided_at,
       c.version
  from claims c
  join payers py on py.tenant_id = c.tenant_id and py.id = c.payer_id`;

const claimView = (row: ClaimRow): Claim => ({
  id: row.id,
  number: `CLM-${String(row.seq).padStart(6, '0')}`,
  patientId: row.patient_id,
  encounterId: row.encounter_id,
  policyId: row.policy_id,
  payerId: row.payer_id,
  payerName: row.payer_name,
  policyNumber: row.policy_number,
  claimedMinor: Number(row.claimed_minor),
  ...(row.approved_minor === null ? {} : { approvedMinor: Number(row.approved_minor) }),
  receivedMinor: Number(row.received_minor),
  writtenOffMinor: Number(row.written_off_minor),
  outstandingMinor: Number(row.outstanding_minor),
  status: row.status,
  ...(row.reference_number === null ? {} : { referenceNumber: row.reference_number }),
  ...(row.open_query === null ? {} : { openQuery: row.open_query }),
  documents: row.documents,
  createdAt: row.created_at.toISOString(),
  ...(row.submitted_at === null ? {} : { submittedAt: row.submitted_at.toISOString() }),
  ...(row.decided_at === null ? {} : { decidedAt: row.decided_at.toISOString() }),
  version: row.version,
});

/** What can be done now: the state machine, less a write-off when nothing is left to give up. */
function allowedActions(row: ClaimRow): ClaimActionKind[] {
  return (Object.keys(CLAIM_TRANSITIONS[row.status]) as ClaimActionKind[]).filter(
    (action) => action !== 'write_off' || Number(row.outstanding_minor) > 0,
  );
}

interface EventRow {
  at: Date;
  action: ClaimEvent['action'];
  to_status: ClaimStatus;
  amount_minor: string | null;
  note: string | null;
}

async function detailOf(client: pg.ClientBase, row: ClaimRow) {
  const { rows } = await client.query<EventRow>(
    `select at, action, to_status, amount_minor, note from claim_events
      where claim_id = $1 order by at desc, id desc`,
    [row.id],
  );
  return {
    ...claimView(row),
    events: rows.map((event): ClaimEvent => ({
      at: event.at.toISOString(),
      action: event.action,
      toStatus: event.to_status,
      ...(event.amount_minor === null ? {} : { amountMinor: Number(event.amount_minor) }),
      ...(event.note === null ? {} : { note: event.note }),
    })),
    allowedActions: allowedActions(row),
  };
}

async function findClaim(client: pg.ClientBase, id: string, lock = false) {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<ClaimRow>(
    `${CLAIMS} where c.id = $1 ${lock ? 'for update of c' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const claimGone = () => new HttpError(404, 'claim_not_found', 'No such claim');

function decodeCursor(cursor: string): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { s?: unknown };
    if (typeof value.s === 'number' && Number.isInteger(value.s) && value.s >= 1) return value.s;
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
}

export const claimRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/claims',
    {
      config: { permissions: ['claim:read'], feature: FEATURE },
      schema: {
        operationId: 'listClaims',
        tags: ['insurance'],
        description: 'Insurance claims, newest first, one cursor page. Needs claim:read.',
        querystring: ClaimListQuery,
        response: { 200: ref(ClaimPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = ['true'];
      if (q.status) {
        params.push(q.status);
        where.push(`c.status = $${params.length}`);
      }
      const totalRow = await request.txClient.query<{ n: number }>(
        `select count(*)::int as n from claims c where ${where.join(' and ')}`,
        params,
      );
      if (q.cursor) {
        params.push(decodeCursor(q.cursor));
        where.push(`c.seq <= $${params.length}`);
      }
      const limit = q.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await request.txClient.query<ClaimRow>(
        `${CLAIMS} where ${where.join(' and ')} order by c.seq desc limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'claim', row.id);
      const next = rows[limit];
      return {
        items: page.map(claimView),
        nextCursor: next
          ? Buffer.from(JSON.stringify({ s: next.seq })).toString('base64url')
          : null,
        total: totalRow.rows[0]?.n ?? 0,
      };
    },
  );

  app.get(
    '/claims/aging',
    {
      config: { permissions: ['claim:read'], feature: FEATURE },
      schema: {
        operationId: 'claimAging',
        tags: ['insurance'],
        description:
          'Money still to come in on claims, by payer and by days since the claim was submitted. Needs claim:read.',
        response: { 200: ref(ClaimAging), ...errors(401, 403, 429) },
      },
    },
    async (request) => {
      const { rows } = await request.txClient.query<{
        payer_id: string;
        payer_name: string;
        claims: number;
        b0: string;
        b1: string;
        b2: string;
        b3: string;
      }>(
        `with live as (
           select c.payer_id, (${OUTSTANDING_SQL}) as owed,
                  floor(extract(epoch from (now() - c.submitted_at)) / 86400) as age
             from claims c where c.submitted_at is not null)
         select l.payer_id, py.name as payer_name, count(*)::int as claims,
                coalesce(sum(owed) filter (where age <= 30), 0) as b0,
                coalesce(sum(owed) filter (where age > 30 and age <= 60), 0) as b1,
                coalesce(sum(owed) filter (where age > 60 and age <= 90), 0) as b2,
                coalesce(sum(owed) filter (where age > 90), 0) as b3
           from live l join payers py on py.id = l.payer_id
          where l.owed > 0 group by l.payer_id, py.name`,
      );
      const asOf = (await request.txClient.query<{ now: Date }>('select now() as now')).rows[0];
      const items = rows
        .map((row) => {
          const buckets = [row.b0, row.b1, row.b2, row.b3].map(Number);
          return {
            payerId: row.payer_id,
            payerName: row.payer_name,
            claims: row.claims,
            buckets,
            outstandingMinor: buckets.reduce((a, b) => a + b, 0),
          };
        })
        .sort((a, b) => b.outstandingMinor - a.outstandingMinor);
      const totals = { claims: 0, buckets: [0, 0, 0, 0], outstandingMinor: 0 };
      for (const row of items) {
        totals.claims += row.claims;
        totals.outstandingMinor += row.outstandingMinor;
        row.buckets.forEach((value, index) => {
          totals.buckets[index] = (totals.buckets[index] ?? 0) + value;
        });
      }
      return { asOf: (asOf?.now ?? new Date()).toISOString(), rows: items, totals };
    },
  );

  app.get(
    '/claims/:claimId',
    {
      config: { permissions: ['claim:read'], feature: FEATURE },
      schema: {
        operationId: 'getClaim',
        tags: ['insurance'],
        description: 'One claim with its history. Needs claim:read.',
        params: ClaimParams,
        response: { 200: ref(ClaimDetail), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await findClaim(request.txClient, request.params.claimId);
      if (!row) throw claimGone();
      request.audit('read', 'claim', row.id);
      return detailOf(request.txClient, row);
    },
  );

  app.post(
    '/encounters/:encounterId/claims',
    {
      config: {
        permissions: ['claim:manage'],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'createClaim',
        tags: ['insurance'],
        headers: RequiredIdempotencyHeaders,
        description:
          "Prepares a claim for a visit: the payer share of the visit's coverage split as it is now, the patient's active policy and the packet of documents (by name). One claim in play per visit (409 `claim_exists`); nothing to claim is 422 `nothing_to_claim`; no active policy is 404 `no_active_policy`. Needs claim:manage. Audited.",
        params: EncounterParams,
        body: ClaimCreate,
        response: { 201: ref(ClaimDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const encounterId = request.params.encounterId;
      const patientId = await visitPatient(client, encounterId);
      await requirePatient(request, patientId);
      const visit = await computeSplit(client, encounterId, patientId);
      if (visit.split.payerMinor <= 0) {
        throw new HttpError(422, 'nothing_to_claim', 'The payer owes nothing');
      }
      const open = await client.query(
        `select 1 from claims where encounter_id = $1 and status not in ('cancelled', 'written_off')`,
        [encounterId],
      );
      if (open.rows.length > 0) {
        throw new HttpError(409, 'claim_exists', 'This visit already has a claim');
      }
      const seq = (
        await client.query<{ last_number: number }>(
          `insert into claim_counters (last_number) values (1)
           on conflict (tenant_id) do update set last_number = claim_counters.last_number + 1
           returning last_number`,
        )
      ).rows[0]?.last_number as number;
      try {
        const { rows } = await client.query<{ id: string }>(
          `insert into claims (seq, patient_id, encounter_id, policy_id, payer_id, policy_number,
             claimed_minor, documents, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9) returning id`,
          [
            seq,
            patientId,
            encounterId,
            visit.split.policyId,
            visit.payerId,
            visit.policyNumber,
            visit.split.payerMinor,
            JSON.stringify(request.body.documents.map(tidy)),
            userIdOf(request),
          ],
        );
        const id = (rows[0] as { id: string }).id;
        await client.query(
          `insert into claim_events (claim_id, action, to_status, note, actor_id)
           values ($1, 'create', 'draft', $2, $3)`,
          [id, request.body.note === undefined ? null : tidy(request.body.note), userIdOf(request)],
        );
        request.audit('create', 'claim', id);
        return reply
          .status(201)
          .send(await detailOf(client, (await findClaim(client, id)) as ClaimRow));
      } catch (error) {
        if (isCode(error, '23505', 'claims_one_open_per_visit')) {
          throw new HttpError(409, 'claim_exists', 'This visit already has a claim');
        }
        throw error;
      }
    },
  );

  app.post(
    '/claims/:claimId/actions',
    {
      config: { permissions: ['claim:manage'], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'actOnClaim',
        tags: ['insurance'],
        headers: IdempotencyHeaders,
        description:
          'Moves a claim along: submit, raise_query, reply, approve, reject, settle, write_off or cancel. Only the transitions of the claim state machine are allowed (409 `invalid_transition` otherwise); a stale `version` is 409 `version_conflict`. Needs claim:manage, and claim:writeoff for write_off. Submitting emits `claim.submitted` and settling `claim.settled`. Audited.',
        params: ClaimParams,
        body: ClaimAction,
        response: { 200: ref(ClaimDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const action = body.action as ClaimActionKind;
      if (action === 'write_off') {
        const policy = await request.access.policy();
        if (!policy?.permissions.some((held) => held.permission === 'claim:writeoff')) {
          throw new HttpError(403, 'forbidden', 'Writing off a claim needs claim:writeoff');
        }
      }
      const probe = await findClaim(client, request.params.claimId);
      if (!probe) throw claimGone();
      const row = (await findClaim(client, probe.id, true)) as ClaimRow;
      if (row.version !== body.version) {
        throw new HttpError(409, 'version_conflict', 'The claim was changed by someone else');
      }
      const next = CLAIM_TRANSITIONS[row.status][action];
      if (!next || !allowedActions(row).includes(action)) {
        throw new HttpError(409, 'invalid_transition', 'The claim cannot be moved this way now');
      }
      const note = body.note === undefined ? undefined : tidy(body.note);
      if (NEEDS_NOTE.includes(action) && !note) {
        throw new HttpError(422, 'validation_failed', 'A note is required');
      }
      const sets: string[] = ['status = $2'];
      const params: unknown[] = [row.id, next];
      const set = (column: string, value: unknown, cast = '') => {
        params.push(value);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      let amount: number | undefined;
      if (action === 'approve') {
        if (body.approvedMinor === undefined || body.approvedMinor > Number(row.claimed_minor)) {
          throw new HttpError(
            422,
            'validation_failed',
            'The approved amount is needed and is at most what was claimed',
          );
        }
        amount = body.approvedMinor;
        set('approved_minor', amount);
      }
      if (action === 'settle') {
        const approved = Number(row.approved_minor ?? 0);
        if (body.receivedMinor === undefined || body.receivedMinor > approved) {
          throw new HttpError(
            422,
            'validation_failed',
            'The payment is needed and is at most what was approved',
          );
        }
        amount = body.receivedMinor;
        set('received_minor', Number(row.received_minor) + amount);
      }
      if (action === 'write_off') {
        amount = Number(row.outstanding_minor);
        set('written_off_minor', Number(row.written_off_minor) + amount);
      }
      if (action === 'submit') sets.push('submitted_at = now()');
      if (action === 'raise_query') set('open_query', note);
      if (action === 'reply') {
        sets.push('open_query = null');
        if (body.documents) {
          const packet = [...row.documents, ...body.documents.map(tidy)];
          if (packet.length > 20) {
            throw new HttpError(422, 'validation_failed', 'A packet holds at most 20 documents');
          }
          set('documents', JSON.stringify(packet), '::jsonb');
        }
      }
      if (action === 'approve' || action === 'reject') sets.push('decided_at = now()');
      if (body.referenceNumber !== undefined) set('reference_number', tidy(body.referenceNumber));
      await client.query(`update claims set ${sets.join(', ')} where id = $1`, params);
      await client.query(
        `insert into claim_events (claim_id, action, to_status, amount_minor, note, actor_id)
         values ($1, $2, $3, $4, $5, $6)`,
        [row.id, action, next, amount ?? null, note ?? null, userIdOf(request)],
      );
      request.audit('update', 'claim', row.id);
      const ids = { encounterId: row.encounter_id, payerId: row.payer_id };
      if (action === 'submit') await request.emit('claim.submitted', row.id, ids);
      if (action === 'settle') {
        await request.emit('claim.settled', row.id, { ...ids, receivedMinor: amount });
      }
      return detailOf(client, (await findClaim(client, row.id)) as ClaimRow);
    },
  );
};
