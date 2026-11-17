import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type, type Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import {
  errors,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
  CursorPage,
  ref,
  StringEnum,
} from '../../core/http/schemas.js';
import { PLAIN_TEXT, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { Code } from '../codes/index.js';
import { EncounterType } from '../clinical/index.js';
import { practisingDoctor } from '../doctors/index.js';
import { patientInScope } from '../patients/index.js';

/**
 * The medical records desk (#570, MR-04): closed encounters whose record is not complete, the
 * coding queue for diagnoses recorded as text, and the log of requests for copies of a record.
 * What is missing is worked out from the encounter every time it is asked, never stored. Behind
 * the `records` switch; the desk sees the whole hospital, so each permission is needed with the
 * scope `all`.
 */
const FEATURE = 'records';
const READ = 'medicalRecord:read';
const CODE_PERMISSION = 'medicalRecord:code';
const ASSIGN = 'medicalRecord:assign';
const REQUEST_READ = 'recordRequest:read';
const REQUEST_MANAGE = 'recordRequest:manage';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const GAPS = ['unsigned_note', 'no_diagnosis', 'no_discharge_summary', 'missing_consent'] as const;
const REQUESTERS = ['patient', 'representative', 'insurer', 'court', 'hospital', 'other'] as const;
const REQUEST_STATES = ['open', 'fulfilled', 'declined'] as const;
const CODING_STATES = ['uncoded', 'coded'] as const;

const named = <const Values extends readonly [string, ...string[]]>(
  $id: string,
  values: Values,
  description?: string,
) =>
  Type.Unsafe<Values[number]>({
    $id,
    type: 'string',
    enum: [...values],
    ...(description ? { description } : {}),
  });

export const RecordGap = named(
  'RecordGap',
  GAPS,
  'What is missing from a closed record: a note left unsigned, no diagnosis, no signed discharge summary for an inpatient stay, no consent on file for a procedure (a signed consent naming the encounter that was not withdrawn, or an uploaded consent document).',
);
export const CodingState = named('CodingState', CODING_STATES);
export const RecordRequester = named('RecordRequester', REQUESTERS);
export const RecordRequestState = named('RecordRequestState', REQUEST_STATES);

export const IncompleteRecord = Type.Object(
  {
    encounterId: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    kind: ref(EncounterType),
    closedAt: Type.String({ format: 'date-time' }),
    doctorName: Type.String(),
    gaps: Type.Array(ref(RecordGap), { minItems: 1 }),
    assignedDoctorId: Type.Optional(Type.String()),
    assignedDoctorName: Type.Optional(Type.String()),
  },
  { $id: 'IncompleteRecord', description: 'A closed encounter whose record is not complete.' },
);
export const IncompleteRecordPage = CursorPage(ref(IncompleteRecord), {
  $id: 'IncompleteRecordPage',
});
export const IncompleteRecordAssign = Type.Object(
  { doctorId: Type.Unsafe<string | null>({ type: ['string', 'null'], format: 'uuid' }) },
  { $id: 'IncompleteRecordAssign', additionalProperties: false },
);
type IncompleteRecordAssign = Static<typeof IncompleteRecordAssign>;

export const CodingItem = Type.Object(
  {
    diagnosisId: Type.String(),
    encounterId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    text: Type.String(),
    code: Type.Optional(ref(Code)),
    recordedAt: Type.String({ format: 'date-time' }),
    doctorName: Type.String(),
    version: Type.Integer({ description: '1 while uncoded, then one more for each coding.' }),
  },
  {
    $id: 'CodingItem',
    description: 'A diagnosis recorded as text, and the code the desk gave it.',
  },
);
export const CodingItemPage = CursorPage(ref(CodingItem), { $id: 'CodingItemPage' });
export const CodeDiagnosis = Type.Object(
  { codeId: Type.String({ format: 'uuid' }), version: Type.Integer({ minimum: 1 }) },
  { $id: 'CodeDiagnosis', additionalProperties: false },
);
type CodeDiagnosis = Static<typeof CodeDiagnosis>;

export const RecordRequest = Type.Object(
  {
    id: Type.String(),
    patientId: Type.String(),
    patientName: Type.String(),
    patientMrn: Type.String(),
    requesterKind: ref(RecordRequester),
    requesterName: Type.String(),
    purpose: Type.String(),
    requestedOn: Type.String({ format: 'date' }),
    dueOn: Type.Optional(Type.String({ format: 'date' })),
    state: ref(RecordRequestState),
    createdByName: Type.String(),
    closedAt: Type.Optional(Type.String({ format: 'date-time' })),
    closedByName: Type.Optional(Type.String()),
    note: Type.Optional(Type.String()),
    version: Type.Integer(),
  },
  { $id: 'RecordRequest', description: 'A request for a copy of a patient’s record.' },
);
export const RecordRequestPage = CursorPage(ref(RecordRequest), { $id: 'RecordRequestPage' });
export const RecordRequestCreate = Type.Object(
  {
    patientId: Type.String({ format: 'uuid' }),
    requesterKind: ref(RecordRequester),
    requesterName: Type.String({ minLength: 1, maxLength: 200, pattern: PLAIN_TEXT }),
    purpose: Type.String({ minLength: 1, maxLength: 500, pattern: PLAIN_TEXT }),
    dueOn: Type.Optional(Type.String({ format: 'date' })),
  },
  { $id: 'RecordRequestCreate', additionalProperties: false },
);
type RecordRequestCreate = Static<typeof RecordRequestCreate>;
export const RecordRequestClose = Type.Object(
  {
    outcome: StringEnum(['fulfilled', 'declined']),
    note: Type.String({ minLength: 1, maxLength: 500, pattern: PLAIN_TEXT }),
    version: Type.Integer({ minimum: 1 }),
    feeServiceId: Type.Optional(Type.String({ format: 'uuid' })),
    feeEncounterId: Type.Optional(Type.String({ format: 'uuid' })),
    copies: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { $id: 'RecordRequestClose', additionalProperties: false },
);
type RecordRequestClose = Static<typeof RecordRequestClose>;

export const RECORDS_DESK_SCHEMAS = [
  RecordGap,
  CodingState,
  RecordRequester,
  RecordRequestState,
  IncompleteRecord,
  IncompleteRecordPage,
  IncompleteRecordAssign,
  CodingItem,
  CodingItemPage,
  CodeDiagnosis,
  RecordRequest,
  RecordRequestPage,
  RecordRequestCreate,
  RecordRequestClose,
] as const;

const Paging = {
  cursor: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(
    Type.Integer({ minimum: 1, maximum: MAX_PAGE_SIZE, description: 'Absent: 25.' }),
  ),
};
const IncompleteQuery = Type.Object({
  ...Paging,
  gap: Type.Optional(ref(RecordGap)),
  kind: Type.Optional(ref(EncounterType)),
});
type IncompleteQuery = Static<typeof IncompleteQuery>;
const CodingQuery = Type.Object({ ...Paging, state: Type.Optional(ref(CodingState)) });
type CodingQuery = Static<typeof CodingQuery>;
const RequestQuery = Type.Object({
  ...Paging,
  state: Type.Optional(ref(RecordRequestState)),
  patientId: Type.Optional(
    Type.String({
      format: 'uuid',
      description: 'Only the requests for this patient; combines with the other filters.',
    }),
  ),
  overdue: Type.Optional(
    Type.Boolean({
      description:
        'true: only open requests whose due day is before today at the hospital; `total` is then the overdue count.',
    }),
  ),
});
type RequestQuery = Static<typeof RequestQuery>;

const iso = (value: Date) => value.toISOString();
const stamp = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

interface Cursor {
  key: string;
  id: string;
}
const encodeCursor = (key: string, id: string) => Buffer.from(`${key}|${id}`).toString('base64url');
function decodeCursor(cursor: string, key: RegExp): Cursor {
  const [value, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!value || !key.test(value) || !id || !UUID.test(id)) {
    throw new HttpError(400, 'invalid_cursor', 'The cursor does not belong to this list');
  }
  return { key: value, id };
}

/** Closed encounters with what each lacks; a row with no gap is a complete record. */
const INCOMPLETE = `
  select e.id as encounter_id, e.patient_id, e.type as kind, e.ended_at,
         ${stamp('e.ended_at')} as order_at,
         p.first_name || ' ' || p.last_name as patient_name, p.mrn as patient_mrn,
         coalesce(du.name, ou.name) as doctor_name,
         ra.doctor_id as assigned_doctor_id, au.name as assigned_doctor_name,
         array_remove(array[
           case when exists (select 1 from clinical_notes n
                              where n.encounter_id = e.id and n.status = 'draft')
                then 'unsigned_note' end,
           case when not exists (select 1 from encounter_diagnoses g
                                  where g.encounter_id = e.id and g.retracted_at is null)
                then 'no_diagnosis' end,
           case when (e.type = 'ipd' and not exists (
                  select 1 from admissions a
                    join discharge_summaries s on s.tenant_id = a.tenant_id
                     and s.admission_id = a.id and s.status = 'signed'
                   where a.encounter_id = e.id))
                 or (e.type in ('daycare', 'er') and exists (
                  select 1 from admissions a
                   where a.source_encounter_id = e.id
                     and not exists (select 1 from discharge_summaries s
                                      where s.tenant_id = a.tenant_id
                                        and s.admission_id = a.id and s.status = 'signed')))
                then 'no_discharge_summary' end,
           case when exists (select 1 from orders o
                              where o.encounter_id = e.id and o.type = 'procedure'
                                and o.status <> 'cancelled')
                 and not exists (select 1 from patient_documents d
                                  where d.encounter_id = e.id and d.category = 'consent'
                                    and d.status in ('scanning', 'clean')
                                    and d.retired_at is null)
                 and not exists (select 1 from patient_consents c
                                  where c.encounter_id = e.id
                                    and not exists (select 1 from consent_withdrawals w
                                                     where w.tenant_id = c.tenant_id
                                                       and w.consent_id = c.id))
                then 'missing_consent' end
         ], null) as gaps
    from encounters e
    join patients p on p.tenant_id = e.tenant_id and p.id = e.patient_id
    left join doctors d on d.tenant_id = e.tenant_id and d.id = e.attending_doctor_id
    left join users du on du.id = d.user_id
    left join users ou on ou.id = e.opened_by
    left join record_assignments ra on ra.tenant_id = e.tenant_id and ra.encounter_id = e.id
    left join doctors ad on ad.tenant_id = ra.tenant_id and ad.id = ra.doctor_id
    left join users au on au.id = ad.user_id
   where e.status = 'closed'`;

interface IncompleteRow {
  encounter_id: string;
  patient_id: string;
  kind: 'opd' | 'ipd' | 'er' | 'daycare';
  ended_at: Date;
  order_at: string;
  patient_name: string;
  patient_mrn: string;
  doctor_name: string;
  assigned_doctor_id: string | null;
  assigned_doctor_name: string | null;
  gaps: (typeof GAPS)[number][];
}
const incompleteView = (row: IncompleteRow) => ({
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  kind: row.kind,
  closedAt: iso(row.ended_at),
  doctorName: row.doctor_name,
  gaps: row.gaps,
  ...(row.assigned_doctor_id ? { assignedDoctorId: row.assigned_doctor_id } : {}),
  ...(row.assigned_doctor_name ? { assignedDoctorName: row.assigned_doctor_name } : {}),
});

const CODING = `
  select g.id as diagnosis_id, g.encounter_id, p.first_name || ' ' || p.last_name as patient_name,
         p.mrn as patient_mrn, g.text, g.recorded_at, ${stamp('g.recorded_at')} as order_at,
         coalesce(u.name, '') as doctor_name, coalesce(c.version, 1) as version,
         cd.id as code_id, cd.system as code_system, c.code, c.code_title,
         exists (select 1 from code_favourites f where f.code_id = c.code_id) as favourite
    from encounter_diagnoses g
    join encounters e on e.tenant_id = g.tenant_id and e.id = g.encounter_id
    join patients p on p.tenant_id = g.tenant_id and p.id = g.patient_id
    left join users u on u.id = g.recorded_by
    left join diagnosis_codings c on c.tenant_id = g.tenant_id and c.diagnosis_id = g.id
    left join codes cd on cd.id = c.code_id
   where e.status = 'closed' and g.retracted_at is null and g.code_id is null
     and g.text is not null`;

interface CodingRow {
  diagnosis_id: string;
  encounter_id: string;
  patient_name: string;
  patient_mrn: string;
  text: string;
  recorded_at: Date;
  order_at: string;
  doctor_name: string;
  version: number;
  code_id: string | null;
  code_system: 'icd10' | 'procedure' | null;
  code: string | null;
  code_title: string | null;
  favourite: boolean;
}
const codingView = (row: CodingRow) => ({
  diagnosisId: row.diagnosis_id,
  encounterId: row.encounter_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  text: row.text,
  ...(row.code_id && row.code_system && row.code && row.code_title
    ? {
        code: {
          id: row.code_id,
          system: row.code_system,
          code: row.code,
          title: row.code_title,
          favourite: row.favourite,
        },
      }
    : {}),
  recordedAt: iso(row.recorded_at),
  doctorName: row.doctor_name,
  version: row.version,
});

const REQUEST_SELECT = `
  select r.id, r.patient_id, p.first_name || ' ' || p.last_name as patient_name,
         p.mrn as patient_mrn, r.requester_kind, r.requester_name, r.purpose,
         to_char(r.requested_on, 'YYYY-MM-DD') as requested_on,
         to_char(r.due_on, 'YYYY-MM-DD') as due_on, r.state,
         coalesce(cu.name, '') as created_by_name, r.closed_at, bu.name as closed_by_name,
         r.note, r.version,
         to_char(coalesce(r.due_on, DATE '9999-12-31'), 'YYYY-MM-DD') as order_key
    from record_requests r
    join patients p on p.tenant_id = r.tenant_id and p.id = r.patient_id
    left join users cu on cu.id = r.created_by
    left join users bu on bu.id = r.closed_by`;

interface RequestRow {
  id: string;
  patient_id: string;
  patient_name: string;
  patient_mrn: string;
  requester_kind: (typeof REQUESTERS)[number];
  requester_name: string;
  purpose: string;
  requested_on: string;
  due_on: string | null;
  state: (typeof REQUEST_STATES)[number];
  created_by_name: string;
  closed_at: Date | null;
  closed_by_name: string | null;
  note: string | null;
  version: number;
  order_key: string;
}
const requestView = (row: RequestRow) => ({
  id: row.id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  requesterKind: row.requester_kind,
  requesterName: row.requester_name,
  purpose: row.purpose,
  requestedOn: row.requested_on,
  ...(row.due_on ? { dueOn: row.due_on } : {}),
  state: row.state,
  createdByName: row.created_by_name,
  ...(row.closed_at ? { closedAt: iso(row.closed_at) } : {}),
  ...(row.closed_by_name ? { closedByName: row.closed_by_name } : {}),
  ...(row.note ? { note: row.note } : {}),
  version: row.version,
});

export const recordsDeskRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of RECORDS_DESK_SCHEMAS) app.addSchema(schema);
  // The shared schemas the answers refer to belong to their own modules; a plugin sees only what
  // it registered itself.
  app.addSchema(EncounterType);
  app.addSchema(Code);

  const userIdOf = (request: FastifyRequest): string => {
    const userId = request.session?.userId;
    if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
    return userId;
  };
  /** The desk works across the hospital: a narrower scope is refused. */
  const wholeHospital = (request: FastifyRequest, ...permissions: Permission[]) => {
    for (const permission of permissions) {
      if (request.access.scope(permission) !== 'all') {
        throw new HttpError(403, 'forbidden', 'Not allowed');
      }
    }
  };

  async function incompleteOne(request: FastifyRequest, encounterId: string) {
    const { rows } = await request.txClient.query<IncompleteRow>(
      `select * from (${INCOMPLETE} and e.id = $1) b where cardinality(b.gaps) > 0`,
      [encounterId],
    );
    return rows[0] ?? null;
  }

  app.get(
    '/records/incomplete',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listIncompleteRecords',
        tags: ['records'],
        description:
          'Closed encounters whose record is not complete, with what is missing, the oldest first (MR-04, #192). The server works out each gap from the encounter: a note left unsigned, no diagnosis, no signed discharge summary for an inpatient stay, no consent on file for a procedure (a signed consent naming the encounter that was not withdrawn, or an uploaded consent document). `gap` and `kind` narrow; `total` comes with the first page. Needs medicalRecord:read with the scope `all` and the records feature flag. Reads are audited.',
        querystring: IncompleteQuery,
        response: { 200: ref(IncompleteRecordPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      wholeHospital(request, READ);
      const query = request.query as IncompleteQuery;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const filters: string[] = ['cardinality(b.gaps) > 0'];
      const params: unknown[] = [];
      if (query.gap) {
        params.push(query.gap);
        filters.push(`$${params.length}::text = any(b.gaps)`);
      }
      if (query.kind) {
        params.push(query.kind);
        filters.push(`b.kind = $${params.length}`);
      }
      const where = filters.join(' and ');
      let total: number | undefined;
      if (!query.cursor) {
        const counted = await request.txClient.query<{ n: string }>(
          `select count(*) as n from (${INCOMPLETE}) b where ${where}`,
          params,
        );
        total = Number(counted.rows[0]?.n ?? 0);
      }
      const paged = [...params];
      let after = '';
      if (query.cursor) {
        const at = decodeCursor(query.cursor, STAMP);
        paged.push(at.key, at.id);
        after = ` and (b.ended_at, b.encounter_id) > ($${paged.length - 1}::timestamptz, $${paged.length}::uuid)`;
      }
      paged.push(limit + 1);
      const { rows } = await request.txClient.query<IncompleteRow>(
        `select * from (${INCOMPLETE}) b where ${where}${after}
          order by b.ended_at, b.encounter_id limit $${paged.length}`,
        paged,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'encounter', row.encounter_id);
      const last = page[page.length - 1];
      return {
        items: page.map(incompleteView),
        nextCursor:
          rows.length > limit && last ? encodeCursor(last.order_at, last.encounter_id) : null,
        ...(total === undefined ? {} : { total }),
      };
    },
  );

  app.post(
    '/records/incomplete/:encounterId/assign',
    {
      config: {
        permissions: [ASSIGN, READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'assignIncompleteRecord',
        tags: ['records'],
        description:
          'Assigns an incomplete record to a doctor to complete, or takes the assignment off (doctorId null). A note for the desk: nothing contacts the doctor. 404 when the encounter is not an incomplete record of this hospital, 422 `not_practising` when the doctor is not one of its practising doctors. Needs medicalRecord:assign and medicalRecord:read with the scope `all` and the records feature flag. Audited.',
        params: Type.Object({ encounterId: Type.String({ format: 'uuid' }) }),
        headers: RequiredIdempotencyHeaders,
        body: ref(IncompleteRecordAssign),
        response: { 200: ref(IncompleteRecord), ...errors(400, 401, 403, 404, 422, 429) },
      },
    },
    async (request) => {
      wholeHospital(request, ASSIGN, READ);
      const { encounterId } = request.params as { encounterId: string };
      const body = request.body as IncompleteRecordAssign;
      const notFound = () => new HttpError(404, 'not_found', 'No such incomplete record');
      if (request.replayOf !== null) {
        const again = await incompleteOne(request, encounterId);
        if (!again) throw notFound();
        return incompleteView(again);
      }
      if (!(await incompleteOne(request, encounterId))) throw notFound();
      if (body.doctorId === null) {
        await request.txClient.query('delete from record_assignments where encounter_id = $1', [
          encounterId,
        ]);
      } else {
        if (!(await practisingDoctor(request.txClient, body.doctorId))) {
          throw new HttpError(422, 'not_practising', 'That doctor does not practise here');
        }
        await request.txClient.query(
          `insert into record_assignments (tenant_id, encounter_id, doctor_id, assigned_by)
           values (app_tenant_id(), $1, $2, $3)
           on conflict (tenant_id, encounter_id)
           do update set doctor_id = excluded.doctor_id, assigned_by = excluded.assigned_by,
                         assigned_at = now()`,
          [encounterId, body.doctorId, userIdOf(request)],
        );
      }
      request.audit('update', 'record_assignment', encounterId);
      const row = await incompleteOne(request, encounterId);
      if (!row) throw notFound();
      return incompleteView(row);
    },
  );

  async function codingOne(request: FastifyRequest, diagnosisId: string) {
    const { rows } = await request.txClient.query<CodingRow>(`${CODING} and g.id = $1`, [
      diagnosisId,
    ]);
    return rows[0] ?? null;
  }

  app.get(
    '/records/coding-queue',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listCodingQueue',
        tags: ['records'],
        description:
          'Diagnoses of closed encounters recorded as text that still have no code (state `uncoded`, the default), or that the desk has coded, the oldest first (MR-04, #192). `total` comes with the first page. Needs medicalRecord:read with the scope `all` and the records feature flag. Reads are audited.',
        querystring: CodingQuery,
        response: { 200: ref(CodingItemPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      wholeHospital(request, READ);
      const query = request.query as CodingQuery;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const state =
        query.state === 'coded' ? 'c.diagnosis_id is not null' : 'c.diagnosis_id is null';
      let total: number | undefined;
      if (!query.cursor) {
        const counted = await request.txClient.query<{ n: string }>(
          `select count(*) as n from (${CODING} and ${state}) q`,
        );
        total = Number(counted.rows[0]?.n ?? 0);
      }
      const params: unknown[] = [];
      let after = '';
      if (query.cursor) {
        const at = decodeCursor(query.cursor, STAMP);
        params.push(at.key, at.id);
        after = ` and (g.recorded_at, g.id) > ($1::timestamptz, $2::uuid)`;
      }
      params.push(limit + 1);
      const { rows } = await request.txClient.query<CodingRow>(
        `${CODING} and ${state}${after} order by g.recorded_at, g.id limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'encounter_diagnosis', row.diagnosis_id);
      const last = page[page.length - 1];
      return {
        items: page.map(codingView),
        nextCursor:
          rows.length > limit && last ? encodeCursor(last.order_at, last.diagnosis_id) : null,
        ...(total === undefined ? {} : { total }),
      };
    },
  );

  app.post(
    '/records/coding-queue/:diagnosisId/code',
    {
      config: {
        permissions: [CODE_PERMISSION, READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'codeDiagnosis',
        tags: ['records'],
        description:
          'Gives a text diagnosis of a closed encounter its ICD-10 code, at the version read. The diagnosis itself is never changed: the code is kept beside it. 404 when it is not in the queue, 409 `version_conflict` when the coding changed since it was read, 422 `not_icd10` when the code is not an ICD-10 code. Coding again replaces the code and is audited. Needs medicalRecord:code and medicalRecord:read with the scope `all` and the records feature flag.',
        params: Type.Object({ diagnosisId: Type.String({ format: 'uuid' }) }),
        headers: RequiredIdempotencyHeaders,
        body: ref(CodeDiagnosis),
        response: { 200: ref(CodingItem), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      wholeHospital(request, CODE_PERMISSION, READ);
      const { diagnosisId } = request.params as { diagnosisId: string };
      const body = request.body as CodeDiagnosis;
      const notFound = () => new HttpError(404, 'not_found', 'No such diagnosis to code');
      if (request.replayOf !== null) {
        const again = await codingOne(request, diagnosisId);
        if (!again) throw notFound();
        return codingView(again);
      }
      const locked = await request.txClient.query(
        `select g.id from encounter_diagnoses g
           join encounters e on e.tenant_id = g.tenant_id and e.id = g.encounter_id
          where g.id = $1 and e.status = 'closed' and g.retracted_at is null
            and g.code_id is null and g.text is not null
            for update of g`,
        [diagnosisId],
      );
      if (locked.rowCount !== 1) throw notFound();
      const current = await request.txClient.query<{ version: number }>(
        'select version from diagnosis_codings where diagnosis_id = $1',
        [diagnosisId],
      );
      const version = current.rows[0]?.version ?? 1;
      if (version !== body.version) {
        throw new HttpError(409, 'version_conflict', 'The diagnosis was coded by someone else');
      }
      const found = await request.txClient.query<{
        id: string;
        system: string;
        code: string;
        title: string;
      }>('select id, system, code, title from codes where id = $1', [body.codeId]);
      const code = found.rows[0];
      if (!code || code.system !== 'icd10') {
        throw new HttpError(422, 'not_icd10', 'A diagnosis takes an ICD-10 code');
      }
      const saved =
        current.rowCount === 0
          ? await request.txClient.query(
              `insert into diagnosis_codings
                 (tenant_id, diagnosis_id, code_id, code, code_title, coded_by)
               values (app_tenant_id(), $1, $2, $3, $4, $5)
               on conflict do nothing`,
              [diagnosisId, code.id, code.code, code.title, userIdOf(request)],
            )
          : await request.txClient.query(
              `update diagnosis_codings
                  set code_id = $2, code = $3, code_title = $4, coded_by = $5, coded_at = now(),
                      version = version + 1
                where diagnosis_id = $1 and version = $6`,
              [diagnosisId, code.id, code.code, code.title, userIdOf(request), version],
            );
      if (saved.rowCount !== 1) {
        throw new HttpError(409, 'version_conflict', 'The diagnosis was coded by someone else');
      }
      request.audit(current.rowCount === 0 ? 'create' : 'update', 'diagnosis_coding', diagnosisId);
      await request.emit('diagnosis.coded', diagnosisId, { codeId: code.id });
      const row = await codingOne(request, diagnosisId);
      if (!row) throw notFound();
      return codingView(row);
    },
  );

  async function requestOne(request: FastifyRequest, id: string) {
    const { rows } = await request.txClient.query<RequestRow>(`${REQUEST_SELECT} where r.id = $1`, [
      id,
    ]);
    return rows[0] ?? null;
  }

  app.get(
    '/record-requests',
    {
      config: { permissions: [REQUEST_READ], feature: FEATURE },
      schema: {
        operationId: 'listRecordRequests',
        tags: ['records'],
        description:
          'The hospital’s requests for copies of a record, the soonest due first and those with no due day last (MR-04, #192). `state` and `patientId` narrow; `overdue=true` keeps the open requests past their due day (today at the hospital), and its `total` is the count for a dashboard widget (`limit=1`); `total` comes with the first page. Needs recordRequest:read with the scope `all` and the records feature flag. Reads are audited.',
        querystring: RequestQuery,
        response: { 200: ref(RecordRequestPage), ...errors(400, 401, 403, 429) },
      },
    },
    async (request) => {
      wholeHospital(request, REQUEST_READ);
      const query = request.query as RequestQuery;
      const limit = query.limit ?? DEFAULT_PAGE_SIZE;
      const filters: string[] = [];
      const params: unknown[] = [];
      if (query.state) {
        params.push(query.state);
        filters.push(`r.state = $${params.length}`);
      }
      if (query.patientId) {
        params.push(query.patientId);
        filters.push(`r.patient_id = $${params.length}`);
      }
      if (query.overdue) {
        filters.push(
          `r.state = 'open' and r.due_on < (now() at time zone (select t.timezone from tenants t where t.id = app_tenant_id()))::date`,
        );
      }
      let total: number | undefined;
      if (!query.cursor) {
        const counted = await request.txClient.query<{ n: string }>(
          `select count(*) as n from record_requests r ${filters.length ? `where ${filters.join(' and ')}` : ''}`,
          params,
        );
        total = Number(counted.rows[0]?.n ?? 0);
      }
      if (query.cursor) {
        const at = decodeCursor(query.cursor, DAY);
        params.push(at.key, at.id);
        filters.push(
          `(coalesce(r.due_on, DATE '9999-12-31'), r.id) > ($${params.length - 1}::date, $${params.length}::uuid)`,
        );
      }
      params.push(limit + 1);
      const { rows } = await request.txClient.query<RequestRow>(
        `${REQUEST_SELECT} ${filters.length ? `where ${filters.join(' and ')}` : ''}
          order by coalesce(r.due_on, DATE '9999-12-31'), r.id limit $${params.length}`,
        params,
      );
      const page = rows.slice(0, limit);
      for (const row of page) request.audit('read', 'record_request', row.id);
      const last = page[page.length - 1];
      return {
        items: page.map(requestView),
        nextCursor: rows.length > limit && last ? encodeCursor(last.order_key, last.id) : null,
        ...(total === undefined ? {} : { total }),
      };
    },
  );

  app.post(
    '/record-requests',
    {
      config: {
        permissions: [REQUEST_MANAGE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createRecordRequest',
        tags: ['records'],
        description:
          'Logs a request for a copy of a patient’s record, dated today at the hospital, with an optional due day (422 `due_in_past` before today). 404 for a patient the caller cannot reach, 409 `patient_merged` for a merged record. Names and purposes travel in the body only. Needs recordRequest:manage and the records feature flag. Audited.',
        headers: RequiredIdempotencyHeaders,
        body: ref(RecordRequestCreate),
        response: { 201: ref(RecordRequest), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as RecordRequestCreate;
      const userId = userIdOf(request);
      if (request.replayOf !== null) {
        const again = request.idempotentId ? await requestOne(request, request.idempotentId) : null;
        if (!again) throw new HttpError(404, 'not_found', 'No such request');
        return reply.status(201).send(requestView(again));
      }
      const inScope = await patientInScope(request.txClient, body.patientId, {
        scope: request.access.scope(REQUEST_MANAGE),
        userId,
      });
      if (!inScope) throw new HttpError(404, 'not_found', 'No such patient');
      const requesterName = tidyWithin(body.requesterName, 200);
      const purpose = tidyWithin(body.purpose, 500);
      if (!requesterName || !purpose) {
        throw new HttpError(400, 'validation_failed', 'Say who asked and why');
      }
      const today = await request.txClient.query<{ day: string }>(
        `select to_char((now() at time zone t.timezone)::date, 'YYYY-MM-DD') as day
           from tenants t where t.id = app_tenant_id()`,
      );
      const requestedOn = today.rows[0]!.day;
      if (body.dueOn && body.dueOn < requestedOn) {
        throw new HttpError(422, 'due_in_past', 'The due day is before today');
      }
      const { rows } = await request.txClient.query<{ id: string }>(
        `insert into record_requests (tenant_id, patient_id, requester_kind, requester_name,
           purpose, requested_on, due_on, created_by)
         values (app_tenant_id(), $1, $2, $3, $4, $5, $6, $7) returning id`,
        [
          body.patientId,
          body.requesterKind,
          requesterName,
          purpose,
          requestedOn,
          body.dueOn ?? null,
          userId,
        ],
      );
      const id = rows[0]!.id;
      request.idempotentId = id;
      request.audit('create', 'record_request', id);
      await request.emit('record.request_created', id, {
        patientId: body.patientId,
        requesterKind: body.requesterKind,
      });
      const row = await requestOne(request, id);
      return reply.status(201).send(requestView(row!));
    },
  );

  app.post(
    '/record-requests/:requestId/close',
    {
      config: {
        permissions: [REQUEST_MANAGE],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'closeRecordRequest',
        tags: ['records'],
        description:
          'Closes an open request as fulfilled or declined, with a note, at the version read; once only, and a closed request is never changed. 409 `already_closed`, 409 `version_conflict`. With `feeServiceId`, `feeEncounterId` (a visit of the patient, not cancelled, 422 `unknown_encounter`) and `copies`, a fulfilled request carries a fee that billing charges to the visit (422 `fee_incomplete`, `fee_needs_fulfilled`, `unknown_service`). Emits `record.request_closed`. Releasing the record itself is a later step. Needs recordRequest:manage and the records feature flag. Audited.',
        params: Type.Object({ requestId: Type.String({ format: 'uuid' }) }),
        headers: RequiredIdempotencyHeaders,
        body: ref(RecordRequestClose),
        response: { 200: ref(RecordRequest), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const { requestId } = request.params as { requestId: string };
      const body = request.body as RecordRequestClose;
      const notFound = () => new HttpError(404, 'not_found', 'No such request');
      if (request.replayOf !== null) {
        const again = await requestOne(request, requestId);
        if (!again) throw notFound();
        return requestView(again);
      }
      const locked = await request.txClient.query<{
        state: string;
        version: number;
        patient_id: string;
      }>('select state, version, patient_id from record_requests where id = $1 for update', [
        requestId,
      ]);
      const current = locked.rows[0];
      if (!current) throw notFound();
      const inScope = await patientInScope(request.txClient, current.patient_id, {
        scope: request.access.scope(REQUEST_MANAGE),
        userId: userIdOf(request),
      });
      if (!inScope) throw notFound();
      if (current.state !== 'open') {
        throw new HttpError(409, 'already_closed', 'This request was closed already');
      }
      if (current.version !== body.version) {
        throw new HttpError(409, 'version_conflict', 'The request has changed since it was read');
      }
      const note = tidyWithin(body.note, 500);
      if (!note) throw new HttpError(400, 'validation_failed', 'A note is needed');
      // A fee names the service, the visit it is charged to and the copies; billing posts it.
      const feeParts = [body.feeServiceId, body.feeEncounterId, body.copies].filter(
        (part) => part !== undefined,
      ).length;
      if (feeParts !== 0 && feeParts !== 3) {
        throw new HttpError(422, 'fee_incomplete', 'A fee needs a service, a visit and the copies');
      }
      if (feeParts === 3) {
        if (body.outcome !== 'fulfilled') {
          throw new HttpError(422, 'fee_needs_fulfilled', 'Only a fulfilled request carries a fee');
        }
        const service = await request.txClient.query(
          'select 1 from services where id = $1 and not archived',
          [body.feeServiceId],
        );
        if (service.rowCount === 0) throw new HttpError(422, 'unknown_service', 'No such service');
        const visit = await request.txClient.query(
          `select 1 from encounters where id = $1 and patient_id = $2 and status <> 'cancelled'`,
          [body.feeEncounterId, current.patient_id],
        );
        if (visit.rowCount === 0) {
          throw new HttpError(422, 'unknown_encounter', 'No such visit of this patient');
        }
      }
      await request.txClient.query(
        `update record_requests set state = $2, closed_at = now(), closed_by = $3, note = $4,
                fee_service_id = $5, fee_encounter_id = $6, fee_copies = $7
          where id = $1`,
        [
          requestId,
          body.outcome,
          userIdOf(request),
          note,
          body.feeServiceId ?? null,
          body.feeEncounterId ?? null,
          body.copies ?? null,
        ],
      );
      request.audit('update', 'record_request', requestId);
      await request.emit('record.request_closed', requestId, {
        patientId: current.patient_id,
        outcome: body.outcome,
        ...(feeParts === 3
          ? {
              serviceId: body.feeServiceId,
              encounterId: body.feeEncounterId,
              copies: body.copies,
            }
          : {}),
      });
      return requestView((await requestOne(request, requestId))!);
    },
  );
};
