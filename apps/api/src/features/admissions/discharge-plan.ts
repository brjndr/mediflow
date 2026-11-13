import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { errors, ref } from '../../core/http/schemas.js';
import { tidyLines } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { findAdmission, type AdmissionRow } from './repository.js';
import { userIdOf } from './routes.js';
import {
  ADVICE_MAX,
  CLEARANCE_KINDS,
  CLEARANCE_NOTE_MAX,
  ClearanceParams,
  DISCHARGE_PLAN_SCHEMAS,
  DischargeAdviceSet,
  DischargeClearanceSet,
  DischargePlan,
  type ClearanceKind,
} from './discharge-plan-schemas.js';
import { AdmissionParams, type DischargeTypeValue } from './schemas.js';

/**
 * The discharge plan of a stay (DS-01, BE-25 #169): the advice for the patient and the clearance
 * of nursing, pharmacy returns and pending laboratory work. The discharge itself
 * (`POST /admissions/{id}/discharge`) is refused while a clearance its type requires is open
 * (409 `clearance_pending`).
 */
const FEATURE = 'admissions';
const READ = 'admission:read';
const DISCHARGE = 'admission:discharge';
/** One permission for each kind, so a nurse cannot clear what the pharmacy or the laboratory owns. */
const CLEAR_BY_KIND: Record<ClearanceKind, Permission> = {
  nursing: 'discharge:clearNursing',
  pharmacy: 'discharge:clearPharmacy',
  lab: 'discharge:clearLab',
};

/** What a discharge of each type waits for: the way a stay ends decides which departments sign. */
export const REQUIRED_CLEARANCES: Record<DischargeTypeValue, readonly ClearanceKind[]> = {
  routine: ['nursing', 'pharmacy', 'lab'],
  referred: ['nursing', 'pharmacy', 'lab'],
  against_advice: ['nursing', 'pharmacy'],
  deceased: ['nursing', 'pharmacy'],
  absconded: [],
};

interface ClearanceRow {
  kind: ClearanceKind;
  status: 'pending' | 'cleared';
  note: string | null;
  changed_at: Date;
  changed_by_name: string | null;
}

/** The plan as it stands; a stay nobody has written to has no advice and nothing cleared. */
export async function planOf(client: pg.ClientBase, admissionId: string) {
  const plan = await client.query<{ advice: string | null; version: number }>(
    'select advice, version from discharge_plans where admission_id = $1',
    [admissionId],
  );
  const { rows } = await client.query<ClearanceRow>(
    `select c.kind, c.status, c.note, c.changed_at, u.name as changed_by_name
     from discharge_clearances c left join users u on u.id = c.changed_by
     where c.admission_id = $1`,
    [admissionId],
  );
  const row = plan.rows[0];
  return {
    admissionId,
    ...(row?.advice ? { advice: row.advice } : {}),
    clearances: CLEARANCE_KINDS.map((kind) => {
      const found = rows.find((each) => each.kind === kind);
      if (!found || found.status !== 'cleared') return { kind, status: 'pending' as const };
      return {
        kind,
        status: 'cleared' as const,
        ...(found.note ? { note: found.note } : {}),
        clearedAt: found.changed_at.toISOString(),
        clearedByName: found.changed_by_name ?? '',
      };
    }),
    version: row?.version ?? 1,
  };
}

/** The clearances a discharge of this type still waits for. */
export async function openClearances(
  client: pg.ClientBase,
  admissionId: string,
  dischargeType: DischargeTypeValue,
): Promise<ClearanceKind[]> {
  const required = REQUIRED_CLEARANCES[dischargeType];
  if (required.length === 0) return [];
  const { rows } = await client.query<{ kind: ClearanceKind }>(
    `select kind from discharge_clearances where admission_id = $1 and status = 'cleared'`,
    [admissionId],
  );
  const cleared = new Set(rows.map((row) => row.kind));
  return required.filter((kind) => !cleared.has(kind));
}

const notFound = () => new HttpError(404, 'admission_not_found', 'No such admission');
const stayClosed = () =>
  new HttpError(409, 'invalid_transition', 'The patient is no longer admitted');

export const dischargePlanRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of DISCHARGE_PLAN_SCHEMAS) app.addSchema(schema);

  /** The admission within the scope the caller holds `permission` with, locked when it changes. */
  async function stayOf(
    request: FastifyRequest,
    permission: Permission,
    forUpdate: boolean,
  ): Promise<AdmissionRow> {
    const { admissionId } = request.params as { admissionId: string };
    const row = await findAdmission(
      request.txClient,
      admissionId,
      { scope: request.access.scope(permission), userId: userIdOf(request) },
      { forUpdate },
    );
    if (!row) throw notFound();
    return row;
  }

  /** Writes to the plan's row, creating it on the first write, and counts the change. */
  async function touchPlan(request: FastifyRequest, admissionId: string, advice?: string) {
    await request.txClient.query(
      `insert into discharge_plans (tenant_id, admission_id, advice, version, updated_by)
       values (app_tenant_id(), $1, $2, 2, $3)
       on conflict (tenant_id, admission_id) do update
         set advice = coalesce($2, discharge_plans.advice),
             version = discharge_plans.version + 1, updated_by = $3, updated_at = now()`,
      [admissionId, advice ?? null, userIdOf(request)],
    );
  }

  app.get(
    '/admissions/:admissionId/discharge-plan',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getDischargePlan',
        tags: ['admissions'],
        description:
          'The discharge plan of an admission (DS-01): the advice for the patient and the clearance of nursing, pharmacy returns and pending laboratory work. A stay with no plan yet has none cleared (version 1). An admission outside the scope the caller holds admission:read with is 404 `admission_not_found`. Requires admission:read and the admissions feature flag. Audited.',
        params: AdmissionParams,
        response: { 200: ref(DischargePlan), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await stayOf(request, READ, false);
      request.audit('read', 'discharge_plan', row.id);
      return planOf(request.txClient, row.id);
    },
  );

  app.put(
    '/admissions/:admissionId/discharge-plan',
    {
      config: {
        permissions: [DISCHARGE, READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'setDischargeAdvice',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description: `Writes the discharge advice (up to ${ADVICE_MAX} characters), replacing the last. Only while the patient is admitted (409 \`invalid_transition\`). The Idempotency-Key header is required: a repeat changes nothing and answers with the plan as it is now. Requires admission:discharge and admission:read. Audited; the advice is never in an event or a log.`,
        params: AdmissionParams,
        body: DischargeAdviceSet,
        response: { 200: ref(DischargePlan), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await stayOf(request, DISCHARGE, true);
      if (request.replayOf === null) {
        if (row.status !== 'admitted') throw stayClosed();
        const advice = tidyLines((request.body as DischargeAdviceSet).advice);
        if (advice === '') throw new HttpError(400, 'validation_failed', 'Advice is needed');
        if ([...advice].length > ADVICE_MAX) {
          throw new HttpError(400, 'validation_failed', 'The advice is too long');
        }
        await touchPlan(request, row.id, advice);
        request.audit('update', 'discharge_plan', row.id);
      }
      return planOf(request.txClient, row.id);
    },
  );

  app.put(
    '/admissions/:admissionId/discharge-plan/clearances/:kind',
    {
      config: {
        permissions: [READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'setDischargeClearance',
        tags: ['admissions'],
        headers: RequiredIdempotencyHeaders,
        description: `Marks one clearance (nursing, pharmacy or lab) cleared or open again, with who and when; a note (up to ${CLEARANCE_NOTE_MAX} characters) goes with a clearance and is dropped when it is reopened. Only while the patient is admitted (409 \`invalid_transition\`); an unknown kind is 400. A discharge while a clearance its type requires is open is 409 \`clearance_pending\` (routine and referred need all three, against advice and deceased need nursing and pharmacy, absconded none). The Idempotency-Key header is required. Requires admission:read and the permission of the kind: discharge:clearNursing, discharge:clearPharmacy or discharge:clearLab (403 otherwise). Audited.`,
        params: ClearanceParams,
        body: DischargeClearanceSet,
        response: { 200: ref(DischargePlan), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { kind } = request.params as { kind: string };
      if (!(CLEARANCE_KINDS as readonly string[]).includes(kind)) {
        throw new HttpError(400, 'validation_failed', 'Not a kind of clearance');
      }
      const needed = CLEAR_BY_KIND[kind as ClearanceKind];
      const policy = await request.access.policy();
      if (!policy?.permissions.some((grant) => grant.permission === needed)) {
        throw new HttpError(403, 'permission_denied', 'Not allowed to clear this kind');
      }
      const row = await stayOf(request, READ, true);
      if (request.replayOf === null) {
        if (row.status !== 'admitted') throw stayClosed();
        const body = request.body as DischargeClearanceSet;
        const note = body.status === 'cleared' && body.note ? tidyLines(body.note) : '';
        if ([...note].length > CLEARANCE_NOTE_MAX) {
          throw new HttpError(400, 'validation_failed', 'The note is too long');
        }
        await request.txClient.query(
          `insert into discharge_clearances (tenant_id, admission_id, kind, status, note, changed_by)
           values (app_tenant_id(), $1, $2, $3, $4, $5)
           on conflict (tenant_id, admission_id, kind) do update
             set status = excluded.status, note = excluded.note,
                 changed_by = excluded.changed_by, changed_at = now()`,
          [row.id, kind, body.status, note === '' ? null : note, userIdOf(request)],
        );
        await touchPlan(request, row.id);
        request.audit('update', 'discharge_plan', row.id);
      }
      return planOf(request.txClient, row.id);
    },
  );
};
