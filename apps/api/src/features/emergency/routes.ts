import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type pg from 'pg';
import { closeEmergencyEncounter, openEmergencyEncounter } from '../clinical/index.js';
import { admitFromEmergency } from '../admissions/index.js';
import { ownDoctorId, practisingDoctor } from '../doctors/index.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  EmergencyCase,
  EmergencyCaseCreate,
  EmergencyCasePage,
  EmergencyDisposition,
  EmergencyMlc,
  EmergencyMlcSave,
  EmergencyNote,
  EmergencyNoteCreate,
  EmergencyNoteListQuery,
  EmergencyNotePage,
  EmergencyStart,
  EmergencyIdentify,
  EmergencyListQuery,
  EmergencyParams,
  EmergencyTriage,
  EmergencyUnidentify,
} from './schemas.js';
import { isUuid, requireGrant, requirePatient, userIdOf } from './util.js';

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
  encounter_id: string | null;
  disposition: EmergencyCase['disposition'] | null;
  disposed_at: Date | null;
  disposition_note: string | null;
  destination: string | null;
  death_at: Date | null;
  admission_id: string | null;
  medico_legal: boolean;
  version: number;
}
const COLUMNS = `x.id, x.tenant_id, x.temp_no, x.patient_id, x.alias, x.sex, x.approximate_age,
       x.complaint, x.arrival_mode, x.category, x.status, x.arrived_at, x.triaged_at,
       x.identified_at, x.encounter_id, x.disposition, x.disposed_at, x.disposition_note,
       x.destination, x.death_at, x.admission_id, x.version,
       exists (select 1 from er_medico_legal m where m.case_id = x.id) as medico_legal`;

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
  ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
  ...(row.disposition === null ? {} : { disposition: row.disposition }),
  ...(row.disposed_at === null ? {} : { disposedAt: row.disposed_at.toISOString() }),
  ...(row.disposition_note === null ? {} : { dispositionNote: row.disposition_note }),
  ...(row.destination === null ? {} : { destination: row.destination }),
  ...(row.death_at === null ? {} : { deathAt: row.death_at.toISOString() }),
  ...(row.admission_id === null ? {} : { admissionId: row.admission_id }),
  medicoLegal: row.medico_legal,
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

interface NoteRow {
  id: string;
  case_id: string;
  kind: EmergencyNote['kind'];
  body: string;
  author_name: string;
  created_at: Date;
  created_text: string;
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
          'Registers an arrival in a few fields. With `patientId` the case is for a patient on record (one the caller may read, else 404 `unknown_patient`; needs the patients module); without it the patient is unidentified and gets a temporary ID (`tempId`, ER-0042 and so on, numbered per hospital) that stays on the case for good. A `category` triages the arrival at once and also needs emergency:triage (403 `permission_denied`). The Idempotency-Key header is required: a repeat registers nobody again. Audited; emits `er.registered` and, with a category, `er.triaged`. Requires emergency:register.',
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
      if (body.category !== undefined) await requireGrant(request, 'emergency:triage');
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
      if (row.encounter_id !== null) {
        throw new HttpError(409, 'has_encounter', 'Care has started on the patient’s record');
      }
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
  app.get(
    '/emergency/cases/:caseId',
    {
      config: { permissions: ['emergency:read'], feature: FEATURE },
      schema: {
        operationId: 'getEmergencyCase',
        tags: ['emergency'],
        description:
          'One case of the department, with its emergency encounter once care has begun and, after the patient left, how. Audited as a read. Requires emergency:read.',
        params: EmergencyParams,
        response: { 200: ref(EmergencyCase), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const row = await findCase(request.txClient, request.params.caseId);
      if (!row) throw caseGone();
      request.audit('read', 'er_case', row.id);
      return view(row);
    },
  );

  app.post(
    '/emergency/cases/:caseId/start',
    {
      config: {
        permissions: ['emergency:care'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'startEmergencyTreatment',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Moves a waiting case to `in_treatment` at the `version` read (409 `version_conflict`; a case already in treatment or disposed is 409 `invalid_transition`). The Idempotency-Key header is required. Audited; emits `er.started`. Requires emergency:care.',
        params: EmergencyParams,
        body: EmergencyStart,
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
      if (row.status !== 'waiting') {
        throw new HttpError(409, 'invalid_transition', 'Treatment has already started');
      }
      await client.query("update er_encounters set status = 'in_treatment' where id = $1", [
        row.id,
      ]);
      request.audit('update', 'er_case', row.id);
      await request.emit('er.started', row.id, {});
      return replyWith(client, row.id);
    },
  );

  app.post(
    '/emergency/cases/:caseId/encounter',
    {
      config: {
        permissions: ['emergency:care'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'openEmergencyEncounter',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Opens the case’s emergency encounter (type `er`) so orders can be placed on it through the clinical orders routes, and moves a waiting case to `in_treatment`. Needs the patient on record (409 `identify_first`); once open it is the same encounter (the case is answered unchanged). The attending doctor is the caller’s own profile when there is one. The Idempotency-Key header is required. Audited; emits `encounter.opened`. Requires emergency:care, encounter:create (403 `permission_denied`) and the clinical module (403 `feature_disabled`).',
        params: EmergencyParams,
        body: EmergencyStart,
        response: { 200: ref(EmergencyCase), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'er_case', request.params.caseId);
        return replyWith(client, request.params.caseId);
      }
      if ((await request.access.policy())?.features['clinical'] !== true) {
        throw new HttpError(403, 'feature_disabled', 'The clinical module is off');
      }
      await requireGrant(request, 'encounter:create');
      const row = await lockedCase(client, request.params.caseId, request.body.version);
      if (row.encounter_id !== null) return view(row);
      if (row.patient_id === null) {
        throw new HttpError(409, 'identify_first', 'Link the patient to a record first');
      }
      const userId = userIdOf(request);
      const doctorId = await ownDoctorId(client, userId);
      const doctor = doctorId ? await practisingDoctor(client, doctorId) : null;
      const encounterId = await openEmergencyEncounter(
        client,
        {
          patientId: row.patient_id,
          doctorId: doctor?.id ?? null,
          departmentId: doctor?.department_id ?? null,
        },
        userId,
      );
      await client.query(
        "update er_encounters set encounter_id = $2, status = 'in_treatment' where id = $1",
        [row.id, encounterId],
      );
      request.audit('update', 'er_case', row.id);
      request.audit('create', 'encounter', encounterId);
      await request.emit('encounter.opened', encounterId, {
        encounterId,
        patientId: row.patient_id,
        type: 'er',
        doctorId: doctor?.id ?? null,
        departmentId: doctor?.department_id ?? null,
      });
      return replyWith(client, row.id);
    },
  );

  const noteView = (row: NoteRow): EmergencyNote => ({
    id: row.id,
    caseId: row.case_id,
    kind: row.kind,
    body: row.body,
    authorName: row.author_name,
    createdAt: row.created_at.toISOString(),
  });
  const NOTE_SELECT = `select n.id, n.case_id, n.kind, n.body, coalesce(u.name, '') as author_name,
                              n.created_at,
                              to_char(n.created_at at time zone 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' as created_text
                         from er_notes n left join users u on u.id = n.created_by`;

  app.get(
    '/emergency/cases/:caseId/notes',
    {
      config: { permissions: ['emergency:care'], feature: FEATURE },
      schema: {
        operationId: 'listEmergencyNotes',
        tags: ['emergency'],
        description:
          'The observation notes and assessments of a case, oldest first, in pages. Every note read is audited. Requires emergency:care.',
        params: EmergencyParams,
        querystring: EmergencyNoteListQuery,
        response: { 200: ref(EmergencyNotePage), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const row = await findCase(client, request.params.caseId);
      if (!row) throw caseGone();
      const limit = request.query.limit ?? DEFAULT_PAGE_SIZE;
      const params: unknown[] = [row.id];
      let after = '';
      if (request.query.cursor) {
        const cursor = decode(request.query.cursor);
        params.push(cursor.a, cursor.i);
        after = 'and (n.created_at, n.id) > ($2::timestamptz, $3::uuid)';
      }
      params.push(limit + 1);
      const { rows } = await client.query<NoteRow>(
        `${NOTE_SELECT}
          where n.case_id = $1 ${after}
          order by n.created_at, n.id limit $${params.length}`,
        params,
      );
      const more = rows.length > limit;
      const page = more ? rows.slice(0, limit) : rows;
      const last = page[page.length - 1];
      for (const note of page) request.audit('read', 'er_note', note.id);
      return {
        items: page.map(noteView),
        nextCursor:
          more && last
            ? Buffer.from(JSON.stringify({ c: 0, a: last.created_text, i: last.id })).toString(
                'base64url',
              )
            : null,
      };
    },
  );

  app.post(
    '/emergency/cases/:caseId/notes',
    {
      config: {
        permissions: ['emergency:care'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'addEmergencyNote',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Adds an observation note or assessment to a case that has not left the department (409 `invalid_transition`). A note is never changed or removed: a correction is a new note. The Idempotency-Key header is required: a repeat adds nothing. Audited. Requires emergency:care.',
        params: EmergencyParams,
        body: EmergencyNoteCreate,
        response: { 201: ref(EmergencyNote), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request, reply) => {
      const client = request.txClient;
      const noteById = async (id: string) => {
        const { rows } = await client.query<NoteRow>(`${NOTE_SELECT} where n.id = $1`, [id]);
        const note = rows[0];
        if (!note) throw caseGone();
        return noteView(note);
      };
      if (request.replayOf !== null && request.idempotentId) {
        request.audit('read', 'er_note', request.idempotentId);
        return reply.status(201).send(await noteById(request.idempotentId));
      }
      const probe = await findCase(client, request.params.caseId);
      if (!probe) throw caseGone();
      const row = (await findCase(client, probe.id, true)) as CaseRow;
      if (row.status === 'disposed') {
        throw new HttpError(409, 'invalid_transition', 'The patient has left the department');
      }
      const { rows } = await client.query<{ id: string }>(
        `insert into er_notes (case_id, kind, body, created_by) values ($1, $2, $3, $4)
         returning id`,
        [row.id, request.body.kind, request.body.body.trim(), userIdOf(request)],
      );
      const id = (rows[0] as { id: string }).id;
      request.idempotentId = id;
      request.audit('create', 'er_note', id);
      return reply.status(201).send(await noteById(id));
    },
  );

  interface MlcRow {
    case_id: string;
    revision: number;
    category: EmergencyMlc['category'];
    narrative: string;
    brought_by: string | null;
    police_informed: boolean;
    police_station: string | null;
    police_reference: string | null;
    recorded_by_name: string;
    recorded_at: Date;
  }
  const latestMlc = async (client: pg.ClientBase, caseId: string): Promise<MlcRow | null> => {
    const { rows } = await client.query<MlcRow>(
      `select m.case_id, m.revision, m.category, m.narrative, m.brought_by, m.police_informed,
              m.police_station, m.police_reference, coalesce(u.name, '') as recorded_by_name,
              m.recorded_at
         from er_medico_legal m left join users u on u.id = m.recorded_by
        where m.case_id = $1 order by m.revision desc limit 1`,
      [caseId],
    );
    return rows[0] ?? null;
  };
  const mlcView = (row: MlcRow): EmergencyMlc => ({
    caseId: row.case_id,
    revision: row.revision,
    category: row.category,
    narrative: row.narrative,
    ...(row.brought_by === null ? {} : { broughtBy: row.brought_by }),
    policeInformed: row.police_informed,
    ...(row.police_station === null ? {} : { policeStation: row.police_station }),
    ...(row.police_reference === null ? {} : { policeReference: row.police_reference }),
    recordedByName: row.recorded_by_name,
    recordedAt: row.recorded_at.toISOString(),
  });

  app.get(
    '/emergency/cases/:caseId/medico-legal',
    {
      config: { permissions: ['medicoLegal:read'], feature: FEATURE },
      schema: {
        operationId: 'getEmergencyMedicoLegal',
        tags: ['emergency'],
        description:
          'The current medico-legal record of a case (404 `not_medico_legal` when the case is not flagged). Every view is audited, also a repeat. Requires medicoLegal:read.',
        params: EmergencyParams,
        response: { 200: ref(EmergencyMlc), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const row = await findCase(client, request.params.caseId);
      if (!row) throw caseGone();
      const record = await latestMlc(client, row.id);
      if (!record) throw new HttpError(404, 'not_medico_legal', 'The case is not medico-legal');
      request.audit('read', 'er_medico_legal', row.id);
      return mlcView(record);
    },
  );

  app.post(
    '/emergency/cases/:caseId/medico-legal/print',
    {
      config: {
        permissions: ['medicoLegal:read'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'printEmergencyMedicoLegal',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Answers the latest revision of the medico-legal record for printing and records the print in the audit log (action `print`, entity `er_medico_legal`, entity id `<caseId>:<revision>`, with the actor). The web app makes the page from this answer and opens the print dialog once it arrives, so the revision printed is the revision recorded. The Idempotency-Key header is required, one per press: a repeat records nothing more. 404 `not_medico_legal` when the case is not flagged. Requires medicoLegal:read.',
        params: EmergencyParams,
        response: { 200: ref(EmergencyMlc), ...errors(400, 401, 403, 404, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const row = await findCase(client, request.params.caseId);
      if (!row) throw caseGone();
      const record = await latestMlc(client, row.id);
      if (!record) throw new HttpError(404, 'not_medico_legal', 'The case is not medico-legal');
      if (request.replayOf === null) {
        request.audit('print', 'er_medico_legal', `${row.id}:${record.revision}`);
      }
      return mlcView(record);
    },
  );

  app.put(
    '/emergency/cases/:caseId/medico-legal',
    {
      config: {
        permissions: ['medicoLegal:manage'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'saveEmergencyMedicoLegal',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Flags a case as medico-legal (`revision` 0) or revises the record at the `revision` read (409 `version_conflict`); nothing is overwritten, each save is a new revision. Also allowed after the patient has left. The category and the account of the injury are required, and a police station when the police are informed (422 `police_station_required`). The Idempotency-Key header is required. Audited; emits `er.medico_legal` (ids and the revision only). Requires medicoLegal:manage.',
        params: EmergencyParams,
        body: EmergencyMlcSave,
        response: { 200: ref(EmergencyMlc), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      const body = request.body;
      const probe = await findCase(client, request.params.caseId);
      if (!probe) throw caseGone();
      if (request.replayOf !== null) {
        request.audit('read', 'er_medico_legal', probe.id);
        const record = await latestMlc(client, probe.id);
        if (!record) throw caseGone();
        return mlcView(record);
      }
      if (body.policeInformed && !body.policeStation?.trim()) {
        throw new HttpError(422, 'police_station_required', 'Name the police station informed');
      }
      // Serialises two people saving the same case.
      await client.query('select 1 from er_encounters where id = $1 for update', [probe.id]);
      const current = await latestMlc(client, probe.id);
      if ((current?.revision ?? 0) !== body.revision) {
        throw new HttpError(409, 'version_conflict', 'The record has changed since it was read');
      }
      const revision = body.revision + 1;
      await client.query(
        `insert into er_medico_legal (case_id, revision, category, narrative, brought_by,
                police_informed, police_station, police_reference, recorded_by)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          probe.id,
          revision,
          body.category,
          body.narrative.trim(),
          body.broughtBy?.trim() ?? null,
          body.policeInformed,
          body.policeInformed ? (body.policeStation?.trim() ?? null) : null,
          body.policeReference?.trim() ?? null,
          userIdOf(request),
        ],
      );
      request.audit(revision === 1 ? 'create' : 'update', 'er_medico_legal', probe.id);
      await request.emit('er.medico_legal', probe.id, { revision });
      const saved = await latestMlc(client, probe.id);
      return mlcView(saved as MlcRow);
    },
  );

  app.post(
    '/emergency/cases/:caseId/disposition',
    {
      config: {
        permissions: ['emergency:dispose'],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'disposeEmergencyCase',
        tags: ['emergency'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Decides how the patient leaves the department, once, at the `version` read (409 `version_conflict`; a case already disposed is 409 `invalid_transition`): `discharge`, `admit`, `refer` (needs a `destination`, 422 `destination_required`) or `expired` (needs `deathAt`, not in the future, 422 `death_time_required` / `death_in_future`). The emergency encounter, if open, is closed with it (409 `unsigned_notes` while a note of it is a draft). `admit` needs the patient on record (409 `identify_first`), the admissions module and admission:create (403), and opens the inpatient admission of type `emergency` with its own encounter and no bed: its id is kept on the case (`admissionId`), and the emergency encounter, orders and notes stay where they were, so the history is preserved. 409 `already_admitted` when the patient is. The Idempotency-Key header is required. Audited; emits `er.disposed` (the type and ids only) and, for admit, `encounter.opened` and `admission.created`. Requires emergency:dispose.',
        params: EmergencyParams,
        body: EmergencyDisposition,
        response: { 200: ref(EmergencyCase), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const client = request.txClient;
      if (request.replayOf !== null) {
        request.audit('read', 'er_case', request.params.caseId);
        return replyWith(client, request.params.caseId);
      }
      const body = request.body;
      const row = await lockedCase(client, request.params.caseId, body.version);
      const userId = userIdOf(request);
      if (body.type === 'refer' && !body.destination?.trim()) {
        throw new HttpError(422, 'destination_required', 'Say where the patient is referred to');
      }
      if (body.type === 'expired') {
        if (body.deathAt === undefined) {
          throw new HttpError(422, 'death_time_required', 'Give the time of death');
        }
        if (Date.parse(body.deathAt) > Date.now() + 60_000) {
          throw new HttpError(422, 'death_in_future', 'The time of death is in the future');
        }
      }
      let admissionId: string | null = null;
      if (body.type === 'admit') {
        if (row.patient_id === null) {
          throw new HttpError(409, 'identify_first', 'Link the patient to a record first');
        }
        const admitted = await admitFromEmergency(request, {
          patientId: row.patient_id,
          ...(body.doctorId === undefined ? {} : { doctorId: body.doctorId }),
          ...(body.note === undefined ? {} : { adviceNote: body.note.trim() }),
        });
        admissionId = admitted.admissionId;
      }
      if (row.encounter_id !== null) {
        const closed = await closeEmergencyEncounter(client, row.encounter_id, userId);
        if (closed === 'unsigned_notes') {
          throw new HttpError(409, 'unsigned_notes', 'A note of the encounter is still a draft');
        }
        request.audit('update', 'encounter', row.encounter_id);
      }
      await client.query(
        `update er_encounters
            set status = 'disposed', disposition = $2, disposed_at = now(), disposed_by = $3,
                disposition_note = $4, destination = $5, death_at = $6, admission_id = $7
          where id = $1`,
        [
          row.id,
          body.type,
          userId,
          body.note?.trim() || null,
          body.type === 'refer' ? (body.destination?.trim() ?? null) : null,
          body.type === 'expired' ? (body.deathAt ?? null) : null,
          admissionId,
        ],
      );
      request.audit('update', 'er_case', row.id);
      await request.emit('er.disposed', row.id, {
        disposition: body.type,
        ...(admissionId === null ? {} : { admissionId }),
        ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
      });
      return replyWith(client, row.id);
    },
  );
};
