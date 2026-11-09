import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  EmergencyCase,
  EmergencyCaseCreate,
  EmergencyCasePage,
  EmergencyIdentify,
  EmergencyListQuery,
  EmergencyParams,
  EmergencyTriage,
  EmergencyUnidentify,
} from './schemas.js';
import { isUuid, requirePatient, userIdOf } from './util.js';

const FEATURE = 'emergency';

/** How long after linking an unidentified case to a patient the link can still be undone. */
export const UNLINK_WINDOW_HOURS = 24;

interface CaseRow {
  id: string;
  tenant_id: string;
  temp_no: number;
  patient_id: string | null;
  alias: string | null;
  sex: EmergencyCase['sex'];
  approximate_age: number | null;
  complaint: string;
  arrival_mode: EmergencyCase['arrivalMode'];
  category: number | null;
  status: EmergencyCase['status'];
  arrived_at: Date;
  triaged_at: Date | null;
  identified_at: Date | null;
  version: number;
}
const COLUMNS = `x.id, x.tenant_id, x.temp_no, x.patient_id, x.alias, x.sex, x.approximate_age,
       x.complaint, x.arrival_mode, x.category, x.status, x.arrived_at, x.triaged_at,
       x.identified_at, x.version`;

const tempIdOf = (no: number) => `ER-${String(no).padStart(4, '0')}`;
const view = (row: CaseRow): EmergencyCase => ({
  id: row.id,
  tenantId: row.tenant_id,
  tempId: tempIdOf(row.temp_no),
  ...(row.patient_id === null ? {} : { patientId: row.patient_id }),
  ...(row.alias === null ? {} : { alias: row.alias }),
  sex: row.sex,
  ...(row.approximate_age === null ? {} : { approximateAge: row.approximate_age }),
  complaint: row.complaint,
  arrivalMode: row.arrival_mode,
  ...(row.category === null ? {} : { category: row.category }),
  status: row.status,
  arrivedAt: row.arrived_at.toISOString(),
  ...(row.triaged_at === null ? {} : { triagedAt: row.triaged_at.toISOString() }),
  ...(row.identified_at === null ? {} : { identifiedAt: row.identified_at.toISOString() }),
  version: row.version,
});

async function findCase(client: pg.ClientBase, id: string, lock = false): Promise<CaseRow | null> {
  if (!isUuid(id)) return null;
  const { rows } = await client.query<CaseRow>(
    `select ${COLUMNS} from er_encounters x where x.id = $1 ${lock ? 'for update' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

const caseGone = () => new HttpError(404, 'case_not_found', 'No such case');

/** The case to change, locked, at the version the caller read. */
async function lockedCase(client: pg.ClientBase, id: string, version: number): Promise<CaseRow> {
  const probe = await findCase(client, id);
  if (!probe) throw caseGone();
  const row = (await findCase(client, probe.id, true)) as CaseRow;
  if (row.version !== version) {
    throw new HttpError(409, 'version_conflict', 'The case has changed since it was read');
  }
  if (row.status === 'disposed') {
    throw new HttpError(409, 'invalid_transition', 'The patient has left the department');
  }
  return row;
}

// The board is ordered untriaged first (category 0), then category, then arrival; its cursor
// carries those three values.
const PG_TIMESTAMP = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d{1,6})?\+00$/;
interface Cursor {
  c: number;
  a: string;
  i: string;
}
function decode(cursor: string): Cursor {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (
      typeof value.c === 'number' &&
      Number.isInteger(value.c) &&
      value.c >= 0 &&
      value.c <= 5 &&
      typeof value.a === 'string' &&
      PG_TIMESTAMP.test(value.a) &&
      typeof value.i === 'string' &&
      isUuid(value.i)
    ) {
      return { c: value.c, a: value.a, i: value.i };
    }
  } catch {
    // fall through
  }
  throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
}

const replyWith = async (client: pg.ClientBase, id: string): Promise<EmergencyCase> => {
  const row = await findCase(client, id);
  if (!row) throw caseGone();
  return view(row);
};

export const emergencyRoutes: FastifyPluginAsyncTypebox = async (app) => {
  app.get(
    '/emergency/cases',
    {
      config: { permissions: ['emergency:read'], feature: FEATURE },
      schema: {
        operationId: 'listEmergencyCases',
        tags: ['emergency'],
        description:
          'The emergency department’s board: cases not yet disposed (or those of one `status`), untriaged arrivals first, then category 1 to 5, then the longest wait. `total` comes with the first page. Every case read is audited. Requires emergency:read.',
        querystring: EmergencyListQuery,
        response: { 200: ref(EmergencyCasePage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      const q = request.query;
      const params: unknown[] = [];
      const where: string[] = [];
      if (q.status) {
        params.push(q.status);
        where.push(`x.status = $${params.length}`);
      } else {
        where.push("x.status <> 'disposed'");
      }
      let total: number | undefined;
      if (!q.cursor) {
        const { rows } = await request.txClient.query<{ n: string }>(
          `select count(*) as n from er_encounters x where ${where.join(' and ')}`,
          params,
        );
        total = Number((rows[0] as { n: string }).n);
      } else {
        const cursor = decode(q.cursor);
        params.push(cursor.c, cursor.a, cursor.i);
        where.push(
          `(coalesce(x.category, 0), x.arrived_at, x.id) > ($${params.length - 2}::int, $${params.length - 1}::timestamptz, $${params.length}::uuid)`,
        );
      }
      const limit = q.limit ?? DEFAULT_PAGE_SIZE;
      params.push(limit + 1);
      const { rows } = await request.txClient.query<CaseRow & { arrived_text: string }>(
        `select ${COLUMNS},
                to_char(x.arrived_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as arrived_text
           from er_encounters x
          where ${where.join(' and ')}
          order by coalesce(x.category, 0), x.arrived_at, x.id
          limit $${params.length}`,
        params,
      );
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      for (const row of page) request.audit('read', 'er_case', row.id);
      return {
        items: page.map(view),
        nextCursor:
          more && last
            ? Buffer.from(
                JSON.stringify({ c: last.category ?? 0, a: last.arrived_text, i: last.id }),
              ).toString('base64url')
            : null,
        ...(total === undefined ? {} : { total }),
      };
    },
  );

  app.post(
    '/emergency/cases',
    {
      config: {
        permissions: ['emergency:register'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'registerEmergencyCase',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Registers an arrival in a few fields. With `patientId` the case is for a patient on record (one the caller may read, else 404 `unknown_patient`; needs the patients module); without it the patient is unidentified and gets a temporary ID (`tempId`, ER-0042 and so on, numbered per hospital) that stays on the case for good. A `category` triages the arrival at once. The Idempotency-Key header is required: a repeat registers nobody again. Audited; emits `er.registered` and, with a category, `er.triaged`. Requires emergency:register.',
        body: EmergencyCaseCreate,
        response: { 201: ref(EmergencyCase), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      if (request.replayOf !== null && request.idempotentId) {
        request.audit('read', 'er_case', request.idempotentId);
        return reply.status(201).send(await replyWith(client, request.idempotentId));
      }
      const body = request.body;
      if (body.patientId !== undefined) await requirePatient(request, body.patientId);
      const counter = await client.query<{ last_no: number }>(
        `insert into er_counters (last_no) values (1)
         on conflict (tenant_id) do update set last_no = er_counters.last_no + 1
         returning last_no`,
      );
      const no = (counter.rows[0] as { last_no: number }).last_no;
      const { rows } = await client.query<{ id: string }>(
        `insert into er_encounters
           (temp_no, patient_id, alias, sex, approximate_age, complaint, arrival_mode, category,
            triaged_at, created_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8::int, case when $8::int is null then null else now() end, $9)
         returning id`,
        [
          no,
          body.patientId ?? null,
          body.alias?.trim() || null,
          body.sex ?? 'unknown',
          body.approximateAge ?? null,
          body.complaint.trim(),
          body.arrivalMode,
          body.category ?? null,
          userIdOf(request),
        ],
      );
      const id = (rows[0] as { id: string }).id;
      request.idempotentId = id;
      request.audit('create', 'er_case', id);
      await request.emit('er.registered', id, {
        arrivalMode: body.arrivalMode,
        identified: body.patientId !== undefined,
      });
      if (body.category !== undefined) {
        await request.emit('er.triaged', id, { category: body.category, previous: null });
      }
      return reply.status(201).send(await replyWith(client, id));
    },
  );

  app.post(
    '/emergency/cases/:caseId/triage',
    {
      config: {
        permissions: ['emergency:triage'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'triageEmergencyCase',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Sets or changes the triage category (1 immediate to 5 non-urgent) of a case that has not left the department, at the `version` read (409 `version_conflict`; a case already disposed is 409 `invalid_transition`). The Idempotency-Key header is required. Audited; emits `er.triaged` with the new and previous category. Requires emergency:triage.',
        params: EmergencyParams,
        body: EmergencyTriage,
        response: { 200: ref(EmergencyCase), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'er_case', request.params.caseId);
        return replyWith(client, request.params.caseId);
      }
      const row = await lockedCase(client, request.params.caseId, request.body.version);
      await client.query(
        'update er_encounters set category = $2, triaged_at = now() where id = $1',
        [row.id, request.body.category],
      );
      request.audit('update', 'er_case', row.id);
      await request.emit('er.triaged', row.id, {
        category: request.body.category,
        previous: row.category,
      });
      return replyWith(client, row.id);
    },
  );

  app.post(
    '/emergency/cases/:caseId/identify',
    {
      config: {
        permissions: ['emergency:register'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'identifyEmergencyCase',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description: `Links an unidentified case to a patient on record once known; the temporary ID stays on the case. The link is a row of its own with who made it and when, and can be undone within ${UNLINK_WINDOW_HOURS} hours (unidentify). A case with a patient is 409 \`already_identified\`; a stale \`version\` 409 \`version_conflict\`; a patient the caller may not read or that does not exist 404 \`unknown_patient\`. The Idempotency-Key header is required. Audited; emits \`er.identified\`. Requires emergency:register.`,
        params: EmergencyParams,
        body: EmergencyIdentify,
        response: { 200: ref(EmergencyCase), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'er_case', request.params.caseId);
        return replyWith(client, request.params.caseId);
      }
      const row = await lockedCase(client, request.params.caseId, request.body.version);
      if (row.patient_id !== null) {
        throw new HttpError(409, 'already_identified', 'The case already has a patient');
      }
      await requirePatient(request, request.body.patientId);
      await client.query(
        'update er_encounters set patient_id = $2, identified_at = now() where id = $1',
        [row.id, request.body.patientId],
      );
      await client.query(
        'insert into er_case_links (case_id, patient_id, linked_by) values ($1, $2, $3)',
        [row.id, request.body.patientId, userIdOf(request)],
      );
      request.audit('update', 'er_case', row.id);
      await request.emit('er.identified', row.id, { patientId: request.body.patientId });
      return replyWith(client, row.id);
    },
  );

  app.post(
    '/emergency/cases/:caseId/unidentify',
    {
      config: {
        permissions: ['emergency:register'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'unidentifyEmergencyCase',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description: `Undoes the link made by identify, within ${UNLINK_WINDOW_HOURS} hours of it, when the wrong patient was chosen: the case is unidentified again under its temporary ID, and the link row is closed with who undid it, when and the \`reason\` (kept, never deleted). A case registered with a patient, or not identified, is 409 \`not_reversible\`; past the window 409 \`window_closed\`; a stale \`version\` 409 \`version_conflict\`. The Idempotency-Key header is required. Audited; emits \`er.unidentified\`. Requires emergency:register.`,
        params: EmergencyParams,
        body: EmergencyUnidentify,
        response: { 200: ref(EmergencyCase), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'er_case', request.params.caseId);
        return replyWith(client, request.params.caseId);
      }
      const row = await lockedCase(client, request.params.caseId, request.body.version);
      const { rows } = await client.query<{ id: string; patient_id: string; in_window: boolean }>(
        `select id, patient_id, linked_at > now() - make_interval(hours => $2) as in_window
           from er_case_links
          where case_id = $1 and undone_at is null
          order by linked_at desc limit 1 for update`,
        [row.id, UNLINK_WINDOW_HOURS],
      );
      const link = rows[0];
      if (!link || row.patient_id === null) {
        throw new HttpError(409, 'not_reversible', 'The case was not linked to a patient here');
      }
      if (!link.in_window) {
        throw new HttpError(409, 'window_closed', 'The link can no longer be undone');
      }
      await client.query(
        'update er_case_links set undone_by = $2, undone_at = now(), undo_reason = $3 where id = $1',
        [link.id, userIdOf(request), request.body.reason.trim()],
      );
      await client.query(
        'update er_encounters set patient_id = null, identified_at = null where id = $1',
        [row.id],
      );
      request.audit('update', 'er_case', row.id);
      await request.emit('er.unidentified', row.id, { patientId: link.patient_id });
      return replyWith(client, row.id);
    },
  );
};
