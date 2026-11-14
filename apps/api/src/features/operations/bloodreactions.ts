import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders, RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { find, UNIT_SELECT, view, type UnitRow } from './bloodbank.js';
import { discardUnits, siblingUnitIds } from './bloodhold.js';
import { isUuid, selectPage } from './page.js';
import type { REACTION_SEVERITIES } from './schemas.js';
import {
  BloodDonorParams,
  BloodDonorTrace,
  BloodUnitParams,
  BloodUnitTrace,
  ReactionParams,
  TransfusionReaction,
  TransfusionReactionCreate,
  TransfusionReactionListQuery,
  TransfusionReactionPage,
  TransfusionReactionUpdateCreate,
  type BloodUnit,
} from './schemas.js';
import { iso, requireGrant, requirePatient, userIdOf } from './util.js';

const FEATURE = 'bloodbank';
const READ = 'transfusionReaction:read';
const RECORD = 'transfusionReaction:record';
const DONOR_READ = 'bloodDonor:read';

type Severity = (typeof REACTION_SEVERITIES)[number];
type Status = BloodUnit['status'];
const RANK: Record<Severity, number> = { mild: 1, moderate: 2, severe: 3 };
const HOLD_REASON = 'Held after a transfusion reaction';

interface ReactionRow {
  id: string;
  blood_unit_id: string;
  patient_id: string;
  encounter_id: string | null;
  transfused_at: Date;
  onset_at: Date;
  severity: Severity;
  kind: TransfusionReaction['kind'];
  actions: string;
  reported_by: string;
  created_at: Date;
}
interface UpdateRow {
  id: string;
  reaction_id: string;
  note: string;
  severity: Severity | null;
  recorded_by: string;
  recorded_at: Date;
}

const SELECT = `select x.id, x.blood_unit_id, x.patient_id, x.encounter_id, x.transfused_at, x.onset_at,
       x.severity, x.kind, x.actions, x.reported_by, x.created_at
  from transfusion_reactions x`;

const notFound = () =>
  new HttpError(404, 'transfusion_reaction_not_found', 'No such transfusion reaction');

const worst = (first: Severity, more: (Severity | null)[]): Severity =>
  more.reduce<Severity>((top, next) => (next && RANK[next] > RANK[top] ? next : top), first);

async function updatesOf(client: pg.ClientBase, ids: string[]): Promise<Map<string, UpdateRow[]>> {
  const map = new Map<string, UpdateRow[]>();
  if (ids.length === 0) return map;
  const { rows } = await client.query<UpdateRow>(
    `select id, reaction_id, note, severity, recorded_by, recorded_at
     from transfusion_reaction_updates where reaction_id = any($1::uuid[])
     order by recorded_at, id`,
    [ids],
  );
  for (const row of rows) map.set(row.reaction_id, [...(map.get(row.reaction_id) ?? []), row]);
  return map;
}

const reactionView = (
  row: ReactionRow,
  updates: UpdateRow[],
  heldUnitIds?: string[],
): TransfusionReaction => ({
  id: row.id,
  unitId: row.blood_unit_id,
  patientId: row.patient_id,
  ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
  transfusedAt: iso(row.transfused_at),
  onsetAt: iso(row.onset_at),
  kind: row.kind,
  severity: row.severity,
  currentSeverity: worst(
    row.severity,
    updates.map((update) => update.severity),
  ),
  actions: row.actions,
  reportedBy: row.reported_by,
  createdAt: iso(row.created_at),
  updates: updates.map((update) => ({
    id: update.id,
    note: update.note,
    ...(update.severity === null ? {} : { severity: update.severity }),
    recordedBy: update.recorded_by,
    recordedAt: iso(update.recorded_at),
  })),
  ...(heldUnitIds === undefined ? {} : { heldUnitIds }),
});

async function reactionsWhere(
  client: pg.ClientBase,
  condition: string,
  param: string,
): Promise<TransfusionReaction[]> {
  const { rows } = await client.query<ReactionRow>(
    `${SELECT} where ${condition} order by x.created_at, x.id`,
    [param],
  );
  const updates = await updatesOf(
    client,
    rows.map((row) => row.id),
  );
  return rows.map((row) => reactionView(row, updates.get(row.id) ?? []));
}

async function holds(request: FastifyRequest, permission: string): Promise<boolean> {
  const policy = await request.access.policy();
  return policy?.permissions.some((grant) => grant.permission === permission) === true;
}

/** Sibling units of a severe or hemolytic reaction are taken out of use, in this transaction. */
const holdSiblings = async (request: FastifyRequest, unitId: string): Promise<string[]> =>
  discardUnits(request, await siblingUnitIds(request, unitId), HOLD_REASON);

export const bloodReactionRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.post(
    '/transfusion-reactions',
    {
      config: {
        permissions: [RECORD],
        feature: FEATURE,
        idempotent: { body: 'full', required: true },
      },
      schema: {
        operationId: 'recordTransfusionReaction',
        tags: ['bloodbank'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a reaction to a transfused unit, for the patient the unit was given to. The unit is issued or transfused (409 `unit_not_given`), the patient is the unit’s (422 `patient_mismatch`) and one the caller may read (422 `unknown_patient`), the visit, when named, is that patient’s (422 `unknown_encounter`), and the times are not in the future and the onset not before the transfusion (422 `invalid_period`). A severe or hemolytic reaction holds the other units of the same collection: each still in stock or issued is discarded with the reason "Held after a transfusion reaction", and their ids come back in `heldUnitIds`. The Idempotency-Key header is required. Audited; emits `blood.reaction_recorded` (ids and severity only), and `blood.unit_status_changed` for each held unit. Requires transfusionReaction:record.',
        body: TransfusionReactionCreate,
        response: { 201: ref(TransfusionReaction), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await find(client, body.unitId);
      if (!probe) throw new HttpError(404, 'blood_unit_not_found', 'No such blood unit');
      const unit = (await find(client, probe.id, true)) as UnitRow;
      if (unit.status !== 'issued' && unit.status !== 'transfused') {
        throw new HttpError(
          409,
          'unit_not_given',
          'A reaction is recorded for a unit that was given',
        );
      }
      await requirePatient(request, body.patientId);
      if (unit.patient_id !== body.patientId) {
        throw new HttpError(422, 'patient_mismatch', 'The unit was not given to this patient');
      }
      const transfusedAt = new Date(body.transfusedAt);
      const onsetAt = new Date(body.onsetAt);
      const limit = Date.now() + 5 * 60_000;
      if (onsetAt < transfusedAt || transfusedAt.getTime() > limit || onsetAt.getTime() > limit) {
        throw new HttpError(422, 'invalid_period', 'Check the times of the transfusion and onset');
      }
      if (body.encounterId !== undefined) {
        const { rows } = await client.query(
          `select 1 from encounters where id::text = $1 and patient_id::text = $2
             and status <> 'cancelled'`,
          [body.encounterId, body.patientId],
        );
        if (rows.length === 0) throw new HttpError(422, 'unknown_encounter', 'No such visit');
      }
      const { rows } = await client.query<ReactionRow>(
        `insert into transfusion_reactions (blood_unit_id, patient_id, encounter_id, transfused_at,
                                            onset_at, severity, kind, actions, reported_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning id, blood_unit_id, patient_id, encounter_id, transfused_at, onset_at, severity,
                   kind, actions, reported_by, created_at`,
        [
          unit.id,
          body.patientId,
          body.encounterId ?? null,
          transfusedAt,
          onsetAt,
          body.severity,
          body.kind,
          body.actions.trim(),
          userIdOf(request),
        ],
      );
      const row = rows[0] as ReactionRow;
      request.audit('create', 'transfusion_reaction', row.id);
      await request.emit('blood.reaction_recorded', row.id, {
        unitId: unit.id,
        patientId: body.patientId,
        severity: body.severity,
      });
      const held =
        body.severity === 'severe' || body.kind === 'hemolytic'
          ? await holdSiblings(request, unit.id)
          : [];
      return reply.status(201).send(reactionView(row, [], held));
    },
  );

  app.get(
    '/transfusion-reactions',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listTransfusionReactions',
        tags: ['bloodbank'],
        description:
          'Transfusion reactions, newest first, with their updates; filter by unit, patient or the severity first reported. Cursor paging. Requires transfusionReaction:read.',
        querystring: TransfusionReactionListQuery,
        response: { 200: ref(TransfusionReactionPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const query = request.query;
      const where: string[] = [];
      const params: unknown[] = [];
      if (query.unitId !== undefined) {
        if (!isUuid(query.unitId)) return { items: [], nextCursor: null };
        params.push(query.unitId);
        where.push(`x.blood_unit_id = $${params.length}`);
      }
      if (query.patientId !== undefined) {
        if (!isUuid(query.patientId)) return { items: [], nextCursor: null };
        params.push(query.patientId);
        where.push(`x.patient_id = $${params.length}`);
      }
      if (query.severity !== undefined) {
        params.push(query.severity);
        where.push(`x.severity = $${params.length}`);
      }
      const page = await selectPage<ReactionRow>(request.txClient, {
        select: SELECT,
        where,
        params,
        order: 'x.created_at',
        desc: true,
        cursor: query.cursor,
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      const updates = await updatesOf(
        request.txClient,
        page.rows.map((row) => row.id),
      );
      return {
        items: page.rows.map((row) => reactionView(row, updates.get(row.id) ?? [])),
        nextCursor: page.nextCursor,
      };
    },
  );

  app.get(
    '/transfusion-reactions/:reactionId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getTransfusionReaction',
        tags: ['bloodbank'],
        description:
          'A reaction with its updates, oldest first. Audited as a read. 404 `transfusion_reaction_not_found`. Requires transfusionReaction:read.',
        params: ReactionParams,
        response: { 200: ref(TransfusionReaction), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const id = request.params.reactionId;
      if (!isUuid(id)) throw notFound();
      const [reaction] = await reactionsWhere(request.txClient, 'x.id = $1', id);
      if (!reaction) throw notFound();
      request.audit('read', 'transfusion_reaction', reaction.id);
      return reaction;
    },
  );

  app.post(
    '/transfusion-reactions/:reactionId/updates',
    {
      config: { permissions: [RECORD], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'updateTransfusionReaction',
        tags: ['bloodbank'],
        headers: IdempotencyHeaders,
        description:
          'Adds a note to a reaction, and may raise its severity (a severity that is not higher than the current one is 422 `severity_not_raised`). Updates are never edited or removed. Raising it to severe holds the unit’s siblings as recording a severe reaction does. Audited; emits `blood.reaction_recorded` again when the severity was raised. Requires transfusionReaction:record.',
        params: ReactionParams,
        body: TransfusionReactionUpdateCreate,
        response: { 201: ref(TransfusionReaction), ...errors(400, 401, 403, 404, 422, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const id = request.params.reactionId;
      if (!isUuid(id)) throw notFound();
      // Serialises two raises of the same reaction, so the "higher than now" check holds.
      await client.query('select pg_advisory_xact_lock(hashtextextended($1, 585))', [id]);
      const [before] = await reactionsWhere(client, 'x.id = $1', id);
      if (!before) throw notFound();
      const body = request.body;
      if (
        body.severity !== undefined &&
        RANK[body.severity as Severity] <= RANK[before.currentSeverity as Severity]
      ) {
        throw new HttpError(422, 'severity_not_raised', 'The severity can only be raised');
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into transfusion_reaction_updates (reaction_id, note, severity, recorded_by)
         values ($1, $2, $3, $4) returning id`,
        [id, body.note.trim(), body.severity ?? null, userIdOf(request)],
      );
      request.audit('create', 'transfusion_reaction_update', (rows[0] as { id: string }).id);
      let held: string[] = [];
      if (body.severity !== undefined) {
        await request.emit('blood.reaction_recorded', id, {
          unitId: before.unitId,
          patientId: before.patientId,
          severity: body.severity,
        });
        if (body.severity === 'severe') held = await holdSiblings(request, before.unitId);
      }
      const [after] = await reactionsWhere(client, 'x.id = $1', id);
      return reply.status(201).send({ ...(after as TransfusionReaction), heldUnitIds: held });
    },
  );

  app.get(
    '/blood-units/:unitId/trace',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'traceBloodUnit',
        tags: ['bloodbank'],
        description:
          'From a unit to the donor who gave it and the patient who received it: the donor (the name only for a caller who also holds bloodDonor:read), the collection, the screening outcome, every move, the cross-matches, the recipient as a patient id (never a name) and the reactions reported. Audited as a read. 404 `blood_unit_not_found`. Requires transfusionReaction:read.',
        params: BloodUnitParams,
        response: { 200: ref(BloodUnitTrace), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const unit = await find(client, request.params.unitId);
      if (!unit) throw new HttpError(404, 'blood_unit_not_found', 'No such blood unit');
      const { rows: origin } = await client.query<{
        donor_id: string | null;
        collection_id: string | null;
        collected_at: Date | null;
        donor_number: string | null;
        donor_group: BloodUnit['bloodGroup'] | null;
        full_name: string | null;
        outcome: 'cleared' | 'reactive' | null;
      }>(
        `select u.donor_id, u.collection_id, c.collected_at, d.donor_number, d.blood_group as donor_group,
                d.full_name, s.outcome
           from blood_units u
           left join blood_collections c on c.id = u.collection_id
           left join blood_donors d on d.id = u.donor_id
           left join blood_screenings s on s.blood_unit_id = u.id
          where u.id = $1`,
        [unit.id],
      );
      const from = origin[0];
      const { rows: events } = await client.query<{
        from_status: Status | null;
        to_status: Status;
        patient_id: string | null;
        reason: string | null;
        actor_id: string;
        occurred_at: Date;
      }>(
        `select from_status, to_status, patient_id, reason, actor_id, occurred_at
           from blood_unit_events where blood_unit_id = $1 order by occurred_at, id`,
        [unit.id],
      );
      const { rows: matches } = await client.query<{
        id: string;
        patient_id: string;
        result: 'compatible' | 'incompatible';
        performed_by: string;
        performed_at: Date;
        valid_until: Date;
      }>(
        `select id, patient_id, result, performed_by, performed_at, valid_until
           from blood_crossmatches where blood_unit_id = $1 order by performed_at desc, id desc`,
        [unit.id],
      );
      const recipient = [...events]
        .reverse()
        .find((event) => event.to_status === 'issued' && event.patient_id !== null)?.patient_id;
      const named = await holds(request, DONOR_READ);
      request.audit('read', 'blood_unit', unit.id);
      return {
        unit: view(unit),
        ...(from?.donor_id && from.donor_number && from.donor_group
          ? {
              donor: {
                id: from.donor_id,
                donorNumber: from.donor_number,
                bloodGroup: from.donor_group,
                ...(named && from.full_name !== null ? { fullName: from.full_name } : {}),
              },
            }
          : {}),
        ...(from?.collection_id ? { collectionId: from.collection_id } : {}),
        ...(from?.collected_at ? { collectedAt: iso(from.collected_at) } : {}),
        ...(from?.outcome ? { screeningOutcome: from.outcome } : {}),
        history: events.map((entry) => ({
          ...(entry.from_status === null ? {} : { fromStatus: entry.from_status }),
          toStatus: entry.to_status,
          ...(entry.patient_id === null ? {} : { patientId: entry.patient_id }),
          ...(entry.reason === null ? {} : { reason: entry.reason }),
          actorId: entry.actor_id,
          occurredAt: iso(entry.occurred_at),
        })),
        crossmatches: matches.map((match) => ({
          id: match.id,
          unitId: unit.id,
          patientId: match.patient_id,
          result: match.result,
          performedBy: match.performed_by,
          performedAt: iso(match.performed_at),
          validUntil: iso(match.valid_until),
        })),
        ...(recipient ? { recipientPatientId: recipient } : {}),
        reactions: await reactionsWhere(client, 'x.blood_unit_id = $1', unit.id),
      };
    },
  );

  app.get(
    '/blood/donors/:donorId/trace',
    {
      config: { permissions: [DONOR_READ], feature: FEATURE },
      schema: {
        operationId: 'traceBloodDonor',
        tags: ['bloodbank'],
        description:
          'From a donor to every unit made from their donations, newest first (at most 200): where each unit is now, the patient it went to as an id (never a name) and how many reactions were reported against it, with the worst severity. Audited as a read. 404 `blood_donor_not_found`. Requires bloodDonor:read and transfusionReaction:read (403 `permission_denied`).',
        params: BloodDonorParams,
        response: { 200: ref(BloodDonorTrace), ...errors(401, 403, 404, 429) },
      },
    },
    async (request) => {
      await requireGrant(request, READ);
      const client = request.txClient;
      const id = request.params.donorId;
      const notDonor = () => new HttpError(404, 'blood_donor_not_found', 'No such donor');
      if (!isUuid(id)) throw notDonor();
      const { rows: donors } = await client.query<{
        id: string;
        donor_number: string;
        blood_group: BloodUnit['bloodGroup'];
        full_name: string;
      }>('select id, donor_number, blood_group, full_name from blood_donors where id = $1', [id]);
      const donor = donors[0];
      if (!donor) throw notDonor();
      const { rows: unitRows } = await client.query<UnitRow & { collection_id: string | null }>(
        `${UNIT_SELECT.replace('x.version,', 'x.version, x.collection_id,')}
          where x.donor_id = $1 order by x.collected_at desc, x.id desc limit 200`,
        [donor.id],
      );
      const ids = unitRows.map((row) => row.id);
      const { rows: given } = await client.query<{ blood_unit_id: string; patient_id: string }>(
        `select distinct on (blood_unit_id) blood_unit_id, patient_id from blood_unit_events
          where blood_unit_id = any($1::uuid[]) and to_status = 'issued' and patient_id is not null
          order by blood_unit_id, occurred_at desc, id desc`,
        [ids],
      );
      const { rows: reactions } = await client.query<{
        id: string;
        blood_unit_id: string;
        severity: Severity;
      }>(
        'select id, blood_unit_id, severity from transfusion_reactions where blood_unit_id = any($1::uuid[])',
        [ids],
      );
      const updates = await updatesOf(
        client,
        reactions.map((reaction) => reaction.id),
      );
      const units = unitRows.map((row) => {
        const severities = reactions
          .filter((reaction) => reaction.blood_unit_id === row.id)
          .map((reaction) =>
            worst(
              reaction.severity,
              (updates.get(reaction.id) ?? []).map((update) => update.severity),
            ),
          );
        const top = severities.reduce<Severity | undefined>(
          (acc, next) => (acc === undefined || RANK[next] > RANK[acc] ? next : acc),
          undefined,
        );
        const recipient = given.find((entry) => entry.blood_unit_id === row.id)?.patient_id;
        return {
          unit: view(row),
          ...(row.collection_id ? { collectionId: row.collection_id } : {}),
          ...(recipient ? { recipientPatientId: recipient } : {}),
          reactionCount: severities.length,
          ...(top ? { worstSeverity: top } : {}),
        };
      });
      request.audit('read', 'blood_donor', donor.id);
      return {
        donor: {
          id: donor.id,
          donorNumber: donor.donor_number,
          bloodGroup: donor.blood_group,
          fullName: donor.full_name,
        },
        units,
      };
    },
  );
};
