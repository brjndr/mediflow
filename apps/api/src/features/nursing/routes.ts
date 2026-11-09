import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { stayInScope, type Stay } from '../admissions/index.js';
import { dietOrdersOf, medicationOrder, medicationOrdersOf } from '../clinical/index.js';
import { requestIndent } from '../inventory/index.js';
import { orderDispensed } from '../pharmacy/index.js';
import {
  ageBasis,
  flagsFor,
  loadRangeRows,
  VITAL_LIMITS,
  VITAL_MEASURES,
} from '../triage/index.js';
import {
  activeMember,
  findMarEntry,
  findProgressNote,
  findStockRequest,
  findWardVital,
  givenInDay,
  insertMarEntry,
  insertProgressNote,
  insertStockRequest,
  insertWardVital,
  listMarEntries,
  listNoteVersions,
  listProgressNotes,
  listWardVitals,
  updateProgressNote,
  type MarEntryRow,
  type NoteVersionRow,
  type ProgressNoteRow,
  type WardVitalRow,
} from './repository.js';
import {
  AdmissionParams,
  EntryParams,
  MarEntry,
  MarEntryCorrect,
  MarEntryCreate,
  MarEntryPage,
  MarOrderPage,
  MarQuery,
  NOTE_BODY_MAX,
  NoteParams,
  NURSING_SCHEMAS,
  PageQuery,
  ProgressNote,
  ProgressNoteCreate,
  ProgressNotePage,
  ProgressNoteUpdate,
  ProgressNoteVersionPage,
  REASON_MAX,
  VitalParams,
  WardDiet,
  WardStockRequest,
  WardStockRequestCreate,
  WardVital,
  WardVitalCorrect,
  WardVitalCreate,
  WardVitalPage,
} from './schemas.js';

const FEATURE = 'nursing';

const VITALS_READ = 'nursingVitals:read';
const VITALS_RECORD = 'nursingVitals:record';
const MAR_READ = 'mar:read';
const MAR_RECORD = 'mar:record';
const NOTE_READ = 'progressNote:read';
const NOTE_WRITE = 'progressNote:write';

const iso = (value: Date) => value.toISOString();
const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const stayNotFound = () => new HttpError(404, 'admission_not_found', 'No such admission');
const notOpen = () => new HttpError(409, 'admission_not_open', 'The patient is no longer admitted');

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

/** The hospital must have these modules on as well as nursing (403 `feature_disabled`). */
async function requireModules(request: FastifyRequest, ...modules: string[]): Promise<void> {
  const policy = await request.access.policy();
  for (const module of modules) {
    if (policy?.features[module] !== true) {
      throw new HttpError(403, 'feature_disabled', `The ${module} module is off`);
    }
  }
}

/**
 * The stay a request is about, within the scope the caller holds `permission` with. One answer
 * for a stay that does not exist, is another hospital's or is out of scope. `forUpdate` locks the
 * admission row, so a discharge and a ward record take turns.
 */
async function stayFor(
  request: FastifyRequest,
  admissionId: string,
  permission: Permission,
  forUpdate = false,
): Promise<Stay> {
  await requireModules(request, 'admissions');
  const stay = await stayInScope(
    request.txClient,
    admissionId,
    { scope: request.access.scope(permission), userId: userIdOf(request) },
    { forUpdate },
  );
  if (!stay) throw stayNotFound();
  return stay;
}

const openStay = (stay: Stay): void => {
  if (stay.status !== 'admitted') throw notOpen();
};

/** The database refusing a write because the stay ended meanwhile. */
function stayRefusal(error: unknown): unknown {
  const { code } = (error ?? {}) as { code?: unknown };
  return code === '23514' ? notOpen() : error;
}

const refusedBy = (error: unknown, constraint: string): boolean => {
  const { code, constraint: name } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  return code === '23505' && name === constraint;
};

const stayEvent = (stay: Stay) => ({
  admissionId: stay.id,
  patientId: stay.patientId,
  encounterId: stay.encounterId,
});

const page = (limit: number | undefined) => limit ?? DEFAULT_PAGE_SIZE;

// --- views -------------------------------------------------------------------------------------

type Flags = Partial<
  Record<'systolic' | 'diastolic' | 'pulse' | 'temperature' | 'spo2', 'low' | 'high'>
>;

/** Vital rows of one stay as the API shows them, flagged against the ranges of the day. */
async function vitalViews(client: pg.ClientBase, rows: WardVitalRow[]) {
  const first = rows[0];
  const basis = first ? await ageBasis(client, first.patient_id) : null;
  const ranges = basis ? await loadRangeRows(client) : [];
  return rows.map((row) => {
    const flags: Flags = basis
      ? flagsFor(basis, ranges, {
          recorded_at: row.observed_at,
          systolic: row.systolic,
          diastolic: row.diastolic,
          pulse: row.pulse,
          temperature: row.temperature,
          spo2: row.spo2,
        })
      : {};
    const values = row as unknown as Record<string, number | null>;
    return {
      id: row.id,
      tenantId: row.tenant_id,
      admissionId: row.admission_id,
      encounterId: row.encounter_id,
      patientId: row.patient_id,
      observedAt: iso(row.observed_at),
      recordedAt: iso(row.recorded_at),
      recordedById: row.recorded_by,
      recordedByName: row.recorded_by_name,
      ...Object.fromEntries(
        VITAL_MEASURES.flatMap((name) => (values[name] === null ? [] : [[name, values[name]]])),
      ),
      flags,
      ...(row.corrects_id === null ? {} : { correctsId: row.corrects_id }),
      ...(row.correction_reason === null ? {} : { correctionReason: row.correction_reason }),
      ...(row.corrected_by_id === null ? {} : { correctedById: row.corrected_by_id }),
    };
  });
}

const entryView = (row: MarEntryRow, warnings: 'not_dispensed'[] = []) => ({
  id: row.id,
  tenantId: row.tenant_id,
  admissionId: row.admission_id,
  orderId: row.order_id,
  drugId: row.drug_id,
  scheduledAt: iso(row.scheduled_at),
  outcome: row.outcome,
  ...(row.dose_given === null ? {} : { doseGiven: row.dose_given }),
  ...(row.route === null ? {} : { route: row.route }),
  ...(row.reason === null ? {} : { reason: row.reason }),
  ...(row.administered_at === null ? {} : { administeredAt: iso(row.administered_at) }),
  recordedAt: iso(row.recorded_at),
  recordedById: row.recorded_by,
  recordedByName: row.recorded_by_name,
  ...(row.witness_by === null ? {} : { witnessId: row.witness_by }),
  ...(row.corrects_id === null ? {} : { correctsId: row.corrects_id }),
  ...(row.corrected_by_id === null ? {} : { correctedById: row.corrected_by_id }),
  ...(warnings.length === 0 ? {} : { warnings }),
});

const noteView = (row: ProgressNoteRow) => ({
  id: row.id,
  tenantId: row.tenant_id,
  admissionId: row.admission_id,
  kind: row.kind,
  body: row.body,
  createdAt: iso(row.created_at),
  createdById: row.created_by,
  createdByName: row.created_by_name,
  updatedAt: iso(row.updated_at),
  updatedById: row.updated_by,
  version: row.version,
});

const versionView = (row: NoteVersionRow) => ({
  version: row.version,
  body: row.body,
  editedAt: iso(row.edited_at),
  editedById: row.edited_by,
  editedByName: row.edited_by_name,
});

// --- rules -------------------------------------------------------------------------------------

/** The measurements of a body: to one decimal, the pressure as a pair. */
function measuresOf(body: object): Record<string, number> {
  const values = body as Record<string, number | undefined>;
  const measures: Record<string, number> = {};
  for (const name of VITAL_MEASURES) {
    const value = values[name];
    if (value === undefined) continue;
    const { minimum, maximum } = VITAL_LIMITS[name];
    if (value < minimum || value > maximum || Number(value.toFixed(1)) !== value) {
      throw invalid(`${name} is not a value the API takes`);
    }
    measures[name] = value;
  }
  if (Object.keys(measures).length === 0) throw invalid('Send at least one measurement');
  const { systolic, diastolic } = measures;
  if ((systolic === undefined) !== (diastolic === undefined)) {
    throw invalid('Systolic and diastolic go together');
  }
  if (systolic !== undefined && diastolic !== undefined && diastolic >= systolic) {
    throw invalid('The diastolic is below the systolic');
  }
  return measures;
}

/** An instant that is not more than a minute ahead of now. */
function notFuture(value: string | undefined, field: string): Date {
  const at = value === undefined ? new Date() : new Date(value);
  if (Number.isNaN(at.getTime())) throw invalid(`${field} is not a time`);
  if (at.getTime() > Date.now() + 60_000) throw invalid(`${field} is in the future`);
  return at;
}

const WORDS: Record<string, number> = {
  od: 1,
  qd: 1,
  daily: 1,
  hs: 1,
  bd: 2,
  bid: 2,
  bds: 2,
  tds: 3,
  tid: 3,
  qid: 4,
  qds: 4,
};

/**
 * How many doses a day an order's frequency allows: "1-0-1" is 2, "TDS" 3, "q6h" 4. Null when it
 * sets no number (as needed, "SOS") or is not understood: no limit is applied then.
 */
export function dosesPerDay(frequency: string): number | null {
  const text = frequency.trim().toLowerCase();
  if (/^\d(-\d){1,3}$/.test(text)) {
    return text.split('-').reduce((sum, part) => sum + Number(part), 0);
  }
  const every = /^q(\d{1,2})h$/.exec(text);
  if (every?.[1]) return Math.max(1, Math.floor(24 / Math.max(1, Number(every[1]))));
  return WORDS[text] ?? null;
}

interface EntryFields {
  outcome: 'given' | 'withheld' | 'refused' | 'missed';
  doseGiven?: string | undefined;
  route?: string | undefined;
  administeredAt?: string | undefined;
  reason?: string | undefined;
  witnessId?: string | undefined;
}

/** What an entry stores, by its outcome; the order fills in what a given dose leaves out. */
function entryFacts(
  body: EntryFields,
  order: { dose: string; route: string },
  correcting: boolean,
) {
  const reason = body.reason === undefined ? null : tidyWithin(body.reason, REASON_MAX);
  if (body.outcome === 'given') {
    return {
      doseGiven: tidyWithin(body.doseGiven ?? order.dose, 50),
      route: body.route ?? order.route,
      administeredAt: notFuture(body.administeredAt, 'administeredAt'),
      reason: reason === '' ? null : reason,
    };
  }
  if (
    body.doseGiven !== undefined ||
    body.route !== undefined ||
    body.administeredAt !== undefined
  ) {
    throw invalid('A dose that was not given has no dose, route or time given');
  }
  if (reason === null || reason === '') {
    throw new HttpError(422, 'reason_required', 'Say why the dose was not given');
  }
  void correcting;
  return { doseGiven: null, route: null, administeredAt: null, reason };
}

// --- routes ------------------------------------------------------------------------------------

export const nursingRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of NURSING_SCHEMAS) app.addSchema(schema);

  const createConfig = (permissions: Permission[]) =>
    ({
      permissions,
      feature: FEATURE,
      idempotent: { body: 'none', required: true },
    }) as const;

  const REPLAY =
    ' The Idempotency-Key header is required: the same key records nothing again and answers with the record as it is now.';
  const SCOPE =
    ' A stay outside the scope the caller holds the permission with, or another hospital’s, answers 404 `admission_not_found`. A stay that has ended takes no new record (409 `admission_not_open`).';

  // --- ward vital signs ------------------------------------------------------------------------

  app.get(
    '/admissions/:admissionId/vitals',
    {
      config: { permissions: [VITALS_READ], feature: FEATURE },
      schema: {
        operationId: 'listWardVitals',
        tags: ['nursing'],
        description: `The vital signs taken on the ward during a stay, by the time they were taken, newest first, each flagged against the ranges in effect that day. Corrections and the readings they correct are both listed.${SCOPE} Every row is audited as a read.`,
        params: AdmissionParams,
        querystring: PageQuery,
        response: { 200: ref(WardVitalPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const stay = await stayFor(request, request.params.admissionId, VITALS_READ);
      const result = await listWardVitals(request.txClient, stay.id, {
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        limit: page(request.query.limit),
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of result.rows) request.audit('read', 'ward_vitals', row.id);
      return {
        items: await vitalViews(request.txClient, result.rows),
        nextCursor: result.nextCursor,
      };
    },
  );

  async function vitalAnswer(request: FastifyRequest, admissionId: string, id: string) {
    const row = await findWardVital(request.txClient, id, admissionId);
    if (!row) throw new Error('reading was not recorded');
    return (await vitalViews(request.txClient, [row]))[0];
  }

  /** The answer to a repeated create: the record now, if it is still within the caller's scope. */
  async function vitalReplay(request: FastifyRequest, reply: FastifyReply) {
    const row = request.idempotentId
      ? await findWardVital(request.txClient, request.idempotentId)
      : null;
    if (!row) throw stayNotFound();
    await stayFor(request, row.admission_id, VITALS_RECORD);
    request.audit('read', 'ward_vitals', row.id);
    return reply.status(201).send((await vitalViews(request.txClient, [row]))[0]);
  }

  app.post(
    '/admissions/:admissionId/vitals',
    {
      config: createConfig([VITALS_RECORD, VITALS_READ]),
      schema: {
        operationId: 'recordWardVitals',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Records a set of vital signs for an admitted patient: at least one measurement, to one decimal within what a body can be, systolic and diastolic together (400 \`validation_failed\`); \`observedAt\` is now unless sent, never in the future. Kept apart from the readings triage takes at the queue.${SCOPE}${REPLAY} Audited; emits \`vitals.recorded\` through the outbox (ids only).`,
        params: AdmissionParams,
        body: ref(WardVitalCreate),
        response: { 201: ref(WardVital), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) return vitalReplay(request, reply);
      const body = request.body as WardVitalCreate;
      const stay = await stayFor(request, request.params.admissionId, VITALS_RECORD, true);
      openStay(stay);
      const measures = measuresOf(body);
      const observedAt = notFuture(body.observedAt, 'observedAt');
      let id: string;
      try {
        id = await insertWardVital(
          request.txClient,
          { ...stayEvent(stay), observedAt, measures },
          userIdOf(request),
        );
      } catch (error) {
        throw stayRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'ward_vitals', id);
      await request.emit('vitals.recorded', id, {
        vitalsId: id,
        setting: 'ward',
        ...stayEvent(stay),
      });
      return reply.status(201).send(await vitalAnswer(request, stay.id, id));
    },
  );

  app.post(
    '/admissions/:admissionId/vitals/:vitalId/correct',
    {
      config: createConfig([VITALS_RECORD, VITALS_READ]),
      schema: {
        operationId: 'correctWardVitals',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Corrects a reading of the stay with a new one that names it and gives a reason; the original is kept. A reading is corrected once (422 \`already_corrected\`, decided by a unique index); one of another stay is 404 \`vital_not_found\`. The correction is taken at the time of the one it corrects.${SCOPE}${REPLAY} Audited; emits \`vitals.recorded\`.`,
        params: VitalParams,
        body: ref(WardVitalCorrect),
        response: { 201: ref(WardVital), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) return vitalReplay(request, reply);
      const body = request.body as WardVitalCorrect;
      const stay = await stayFor(request, request.params.admissionId, VITALS_RECORD, true);
      openStay(stay);
      const corrected = await findWardVital(request.txClient, request.params.vitalId, stay.id);
      if (!corrected) throw new HttpError(404, 'vital_not_found', 'No such reading');
      if (corrected.corrected_by_id !== null) {
        throw new HttpError(422, 'already_corrected', 'The reading is already corrected');
      }
      const measures = measuresOf(body);
      const reason = tidyWithin(body.reason, REASON_MAX);
      if (reason === '') throw invalid('Say why the reading is corrected');
      let id: string;
      try {
        id = await insertWardVital(
          request.txClient,
          {
            ...stayEvent(stay),
            observedAt: corrected.observed_at,
            measures,
            correctsId: corrected.id,
            correctionReason: reason,
          },
          userIdOf(request),
        );
      } catch (error) {
        if (refusedBy(error, 'ward_vitals_corrected_once')) {
          throw new HttpError(422, 'already_corrected', 'The reading is already corrected');
        }
        throw stayRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'ward_vitals', id);
      await request.emit('vitals.recorded', id, {
        vitalsId: id,
        setting: 'ward',
        correctsId: corrected.id,
        ...stayEvent(stay),
      });
      return reply.status(201).send(await vitalAnswer(request, stay.id, id));
    },
  );

  // --- the medication chart --------------------------------------------------------------------

  app.get(
    '/admissions/:admissionId/mar/orders',
    {
      config: { permissions: [MAR_READ], feature: FEATURE },
      schema: {
        operationId: 'listMarOrders',
        tags: ['nursing'],
        description: `The medication orders of the stay, oldest first (at most 100), as the ward chart shows them, with whether the pharmacy has dispensed against each. Needs the clinical module.${SCOPE} Every order is audited as a read.`,
        params: AdmissionParams,
        response: { 200: ref(MarOrderPage), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      await requireModules(request, 'clinical');
      const stay = await stayFor(request, request.params.admissionId, MAR_READ);
      const orders = await medicationOrdersOf(request.txClient, stay.encounterId, 100);
      const items = [];
      for (const order of orders) {
        request.audit('read', 'order', order.id);
        items.push({
          id: order.id,
          drugId: order.drugId,
          itemName: order.itemName,
          dose: order.dose,
          route: order.route,
          frequency: order.frequency,
          status: order.status,
          placedAt: iso(order.placedAt),
          dispensed: await orderDispensed(request.txClient, order.id),
        });
      }
      return { items, nextCursor: null };
    },
  );

  app.get(
    '/admissions/:admissionId/mar',
    {
      config: { permissions: [MAR_READ], feature: FEATURE },
      schema: {
        operationId: 'listMarEntries',
        tags: ['nursing'],
        description: `The entries on the stay’s medication chart by the time each dose was due, newest first; optionally those of one order. Corrections and the entries they correct are both listed.${SCOPE} Every entry is audited as a read.`,
        params: AdmissionParams,
        querystring: MarQuery,
        response: { 200: ref(MarEntryPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const stay = await stayFor(request, request.params.admissionId, MAR_READ);
      const result = await listMarEntries(request.txClient, stay.id, {
        orderId: request.query.orderId,
        cursor: request.query.cursor,
        limit: page(request.query.limit),
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of result.rows) request.audit('read', 'mar_entry', row.id);
      return { items: result.rows.map((row) => entryView(row)), nextCursor: result.nextCursor };
    },
  );

  async function entryReplay(request: FastifyRequest, reply: FastifyReply) {
    const row = request.idempotentId
      ? await findMarEntry(request.txClient, request.idempotentId)
      : null;
    if (!row) throw stayNotFound();
    await stayFor(request, row.admission_id, MAR_RECORD);
    request.audit('read', 'mar_entry', row.id);
    return reply.status(201).send(entryView(row));
  }

  /** Checks a witness and the dose count, then writes the entry and announces it. */
  async function writeEntry(
    request: FastifyRequest,
    stay: Stay,
    order: NonNullable<Awaited<ReturnType<typeof medicationOrder>>>,
    scheduledAt: Date,
    body: EntryFields,
    correcting: MarEntryRow | null,
  ) {
    const userId = userIdOf(request);
    const facts = entryFacts(body, order, correcting !== null);
    if (body.witnessId !== undefined) {
      if (body.witnessId.toLowerCase() === userId.toLowerCase()) {
        throw new HttpError(422, 'unknown_witness', 'A witness is someone else');
      }
      if (!(await activeMember(request.txClient, body.witnessId))) {
        throw new HttpError(422, 'unknown_witness', 'No such member of staff');
      }
    }
    if (body.outcome === 'given') {
      const limit = dosesPerDay(order.frequency);
      if (limit !== null && facts.reason === null) {
        let given = await givenInDay(request.txClient, order.id, scheduledAt);
        if (correcting?.outcome === 'given') given -= 1;
        if (given + 1 > limit) {
          throw new HttpError(
            422,
            'extra_dose_reason_required',
            'A dose beyond the order frequency needs a reason',
          );
        }
      }
    }
    let id: string;
    try {
      id = await insertMarEntry(
        request.txClient,
        {
          ...stayEvent(stay),
          orderId: order.id,
          drugId: order.drugId,
          scheduledAt,
          outcome: body.outcome,
          doseGiven: facts.doseGiven,
          route: facts.route,
          reason: facts.reason,
          administeredAt: facts.administeredAt,
          witnessId: body.witnessId?.toLowerCase() ?? null,
          correctsId: correcting?.id ?? null,
        },
        userId,
      );
    } catch (error) {
      if (refusedBy(error, 'mar_entries_slot_once')) {
        throw new HttpError(409, 'slot_recorded', 'That dose already has an entry; correct it');
      }
      if (refusedBy(error, 'mar_entries_corrected_once')) {
        throw new HttpError(422, 'already_corrected', 'The entry is already corrected');
      }
      throw stayRefusal(error);
    }
    request.idempotentId = id;
    request.audit('create', 'mar_entry', id);
    await request.emit('medication.administered', id, {
      entryId: id,
      orderId: order.id,
      drugId: order.drugId,
      outcome: body.outcome,
      ...(correcting ? { correctsId: correcting.id } : {}),
      ...stayEvent(stay),
    });
    return id;
  }

  async function entryAnswer(request: FastifyRequest, id: string, orderId: string) {
    const row = await findMarEntry(request.txClient, id);
    if (!row) throw new Error('entry was not recorded');
    const warnings: 'not_dispensed'[] = (await orderDispensed(request.txClient, orderId))
      ? []
      : ['not_dispensed'];
    return entryView(row, warnings);
  }

  app.post(
    '/mar/entries',
    {
      config: createConfig([MAR_RECORD, MAR_READ]),
      schema: {
        operationId: 'recordMarEntry',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Records what happened at a scheduled dose of a medication order of the stay: given, withheld, refused or missed. The order must be of the stay encounter (422 \`unknown_order\`) and not cancelled (409 \`order_cancelled\`); a dose due at a time has one entry (409 \`slot_recorded\`, then correct it). Anything but given needs a reason (422 \`reason_required\`) and carries no dose, route or time given (400); a given dose takes the order dose and route unless sent, and one beyond the doses a day the order frequency allows needs a reason (422 \`extra_dose_reason_required\`; as-needed and unreadable frequencies set no limit). A witness, if named, is another active member of staff (422 \`unknown_witness\`). The answer warns \`not_dispensed\` when the pharmacy has dispensed nothing against the order; it does not refuse. This records the administration only: it does not change the order or call the pharmacy. Needs the clinical module.${SCOPE}${REPLAY} Audited; emits \`medication.administered\` (ids and the outcome, never a reason).`,
        body: ref(MarEntryCreate),
        response: { 201: ref(MarEntry), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) return entryReplay(request, reply);
      await requireModules(request, 'clinical');
      const body = request.body as MarEntryCreate;
      const stay = await stayFor(request, body.admissionId, MAR_RECORD, true);
      openStay(stay);
      const order = await medicationOrder(request.txClient, body.orderId, { forUpdate: true });
      if (!order || order.encounterId !== stay.encounterId) {
        throw new HttpError(422, 'unknown_order', 'No such medication order for this stay');
      }
      if (order.status === 'cancelled') {
        throw new HttpError(409, 'order_cancelled', 'The order was cancelled');
      }
      const scheduledAt = new Date(body.scheduledAt);
      if (Number.isNaN(scheduledAt.getTime())) throw invalid('scheduledAt is not a time');
      const id = await writeEntry(request, stay, order, scheduledAt, body, null);
      return reply.status(201).send(await entryAnswer(request, id, order.id));
    },
  );

  app.post(
    '/mar/entries/:entryId/correct',
    {
      config: createConfig([MAR_RECORD, MAR_READ]),
      schema: {
        operationId: 'correctMarEntry',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Corrects an entry with a new one for the same order and time that names it and gives a reason; the original is kept. An entry is corrected once (422 \`already_corrected\`). The same rules as recording apply to the new entry. Needs the clinical module.${SCOPE}${REPLAY} Audited; emits \`medication.administered\` with \`correctsId\`.`,
        params: EntryParams,
        body: ref(MarEntryCorrect),
        response: { 201: ref(MarEntry), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) return entryReplay(request, reply);
      await requireModules(request, 'clinical');
      const body = request.body as MarEntryCorrect;
      const found = await findMarEntry(request.txClient, request.params.entryId);
      if (!found) throw new HttpError(404, 'entry_not_found', 'No such entry');
      const stay = await stayFor(request, found.admission_id, MAR_RECORD, true);
      openStay(stay);
      const entry = await findMarEntry(request.txClient, found.id);
      if (!entry) throw new HttpError(404, 'entry_not_found', 'No such entry');
      if (entry.corrected_by_id !== null) {
        throw new HttpError(422, 'already_corrected', 'The entry is already corrected');
      }
      const order = await medicationOrder(request.txClient, entry.order_id, { forUpdate: true });
      if (!order) throw new HttpError(404, 'entry_not_found', 'No such entry');
      const id = await writeEntry(request, stay, order, entry.scheduled_at, body, entry);
      return reply.status(201).send(await entryAnswer(request, id, order.id));
    },
  );

  // --- progress notes --------------------------------------------------------------------------

  app.get(
    '/admissions/:admissionId/progress-notes',
    {
      config: { permissions: [NOTE_READ], feature: FEATURE },
      schema: {
        operationId: 'listProgressNotes',
        tags: ['nursing'],
        description: `The progress notes of the stay, newest first, with the text as it stands.${SCOPE} Every note is audited as a read.`,
        params: AdmissionParams,
        querystring: PageQuery,
        response: { 200: ref(ProgressNotePage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const stay = await stayFor(request, request.params.admissionId, NOTE_READ);
      const result = await listProgressNotes(request.txClient, stay.id, {
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        limit: page(request.query.limit),
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of result.rows) request.audit('read', 'progress_note', row.id);
      return { items: result.rows.map(noteView), nextCursor: result.nextCursor };
    },
  );

  app.post(
    '/admissions/:admissionId/progress-notes',
    {
      config: createConfig([NOTE_WRITE, NOTE_READ]),
      schema: {
        operationId: 'createProgressNote',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Writes a progress note for an admitted patient: a kind (nursing, handover or observation) and plain text of up to ${NOTE_BODY_MAX} characters.${SCOPE}${REPLAY} Audited; emits \`progressnote.created\` (ids and the kind, never the text).`,
        params: AdmissionParams,
        body: ref(ProgressNoteCreate),
        response: { 201: ref(ProgressNote), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const row = request.idempotentId
          ? await findProgressNote(request.txClient, request.idempotentId)
          : null;
        if (!row) throw stayNotFound();
        await stayFor(request, row.admission_id, NOTE_WRITE);
        request.audit('read', 'progress_note', row.id);
        return reply.status(201).send(noteView(row));
      }
      const body = request.body as ProgressNoteCreate;
      const stay = await stayFor(request, request.params.admissionId, NOTE_WRITE, true);
      openStay(stay);
      const text = tidyWithin(body.body, NOTE_BODY_MAX);
      if (text === '') throw invalid('A note says something');
      let id: string;
      try {
        id = await insertProgressNote(
          request.txClient,
          { ...stayEvent(stay), kind: body.kind, body: text },
          userIdOf(request),
        );
      } catch (error) {
        throw stayRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'progress_note', id);
      await request.emit('progressnote.created', id, {
        noteId: id,
        kind: body.kind,
        ...stayEvent(stay),
      });
      const row = await findProgressNote(request.txClient, id);
      if (!row) throw new Error('note was not recorded');
      return reply.status(201).send(noteView(row));
    },
  );

  app.patch(
    '/progress-notes/:noteId',
    {
      config: { permissions: [NOTE_WRITE, NOTE_READ], feature: FEATURE },
      schema: {
        operationId: 'updateProgressNote',
        tags: ['nursing'],
        description: `Changes the text of a note its author wrote, while the patient is admitted, at the version the edit started from (409 \`conflict\`). Someone else’s note is 403 \`not_author\`. The new text is added to the note history; earlier texts stay. A note outside the caller scope, or another hospital’s, is 404 \`note_not_found\`; of a stay that has ended, 409 \`admission_not_open\`. Audited; emits \`progressnote.updated\`.`,
        params: NoteParams,
        body: ref(ProgressNoteUpdate),
        response: { 200: ref(ProgressNote), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const body = request.body as ProgressNoteUpdate;
      const userId = userIdOf(request);
      const found = await findProgressNote(request.txClient, request.params.noteId);
      if (!found) throw new HttpError(404, 'note_not_found', 'No such note');
      let stay: Stay;
      try {
        stay = await stayFor(request, found.admission_id, NOTE_WRITE, true);
      } catch (error) {
        if (error instanceof HttpError && error.code === 'admission_not_found') {
          throw new HttpError(404, 'note_not_found', 'No such note');
        }
        throw error;
      }
      openStay(stay);
      const note = await findProgressNote(request.txClient, found.id, { forUpdate: true });
      if (!note) throw new HttpError(404, 'note_not_found', 'No such note');
      if (note.created_by.toLowerCase() !== userId.toLowerCase()) {
        throw new HttpError(403, 'not_author', 'Only the author edits a note');
      }
      if (note.version !== body.version) {
        throw new HttpError(409, 'conflict', 'It has changed since it was read');
      }
      const text = tidyWithin(body.body, NOTE_BODY_MAX);
      if (text === '') throw invalid('A note says something');
      try {
        await updateProgressNote(request.txClient, note.id, text, userId);
      } catch (error) {
        throw stayRefusal(error);
      }
      request.audit('update', 'progress_note', note.id);
      await request.emit('progressnote.updated', note.id, {
        noteId: note.id,
        version: note.version + 1,
        ...stayEvent(stay),
      });
      const row = await findProgressNote(request.txClient, note.id);
      if (!row) throw new Error('note was not changed');
      return noteView(row);
    },
  );

  app.get(
    '/progress-notes/:noteId/history',
    {
      config: { permissions: [NOTE_READ], feature: FEATURE },
      schema: {
        operationId: 'listProgressNoteVersions',
        tags: ['nursing'],
        description:
          'Every text a note has had, newest first, with who saved it and when. A note outside the caller scope, or another hospital’s, is 404 `note_not_found`. Audited as a read of the note.',
        params: NoteParams,
        querystring: PageQuery,
        response: { 200: ref(ProgressNoteVersionPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const found = await findProgressNote(request.txClient, request.params.noteId);
      if (!found) throw new HttpError(404, 'note_not_found', 'No such note');
      try {
        await stayFor(request, found.admission_id, NOTE_READ);
      } catch (error) {
        if (error instanceof HttpError && error.code === 'admission_not_found') {
          throw new HttpError(404, 'note_not_found', 'No such note');
        }
        throw error;
      }
      const result = await listNoteVersions(request.txClient, found.id, {
        ...(request.query.cursor === undefined ? {} : { cursor: request.query.cursor }),
        limit: page(request.query.limit),
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      request.audit('read', 'progress_note', found.id);
      return { items: result.rows.map(versionView), nextCursor: result.nextCursor };
    },
  );

  // --- diet ------------------------------------------------------------------------------------

  app.get(
    '/admissions/:admissionId/diet',
    {
      config: { permissions: ['order:read'], feature: FEATURE },
      schema: {
        operationId: 'getWardDiet',
        tags: ['nursing'],
        description: `The diet orders of the stay that are not cancelled, newest first, read from the unified orders: the ward reads them and never places one (that is order:create, the doctor’s). Needs the clinical module.${SCOPE} Every order is audited as a read.`,
        params: AdmissionParams,
        response: { 200: ref(WardDiet), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      await requireModules(request, 'clinical');
      const stay = await stayFor(request, request.params.admissionId, 'order:read');
      const orders = await dietOrdersOf(request.txClient, stay.encounterId);
      for (const order of orders) request.audit('read', 'order', order.id);
      return {
        items: orders.map((order) => ({
          id: order.id,
          status: order.status,
          priority: order.priority,
          instructions: order.instructions,
          placedAt: iso(order.placedAt),
        })),
      };
    },
  );

  // --- ward stock ------------------------------------------------------------------------------

  const stockRequestView = (row: NonNullable<Awaited<ReturnType<typeof findStockRequest>>>) => ({
    id: row.id,
    admissionId: row.admission_id,
    indentId: row.indent_id,
    placeId: row.place_id,
    requestedAt: iso(row.requested_at),
    requestedById: row.requested_by,
  });

  app.post(
    '/admissions/:admissionId/stock-requests',
    {
      config: createConfig(['indent:create', 'indent:read']),
      schema: {
        operationId: 'requestWardStock',
        tags: ['nursing'],
        headers: RequiredIdempotencyHeaders,
        description: `Asks a store for items for the ward on behalf of an admitted patient: an indent from the ward place (\`fromLocationId\`) to a store, made in this request transaction with the checks of createStockIndent (400), and linked to the stay. The store keeper approves and issues it through the indents routes as for any indent. Needs the inventory module.${SCOPE}${REPLAY} Audited; emits \`ward.stockrequested\` (ids only).`,
        params: AdmissionParams,
        body: ref(WardStockRequestCreate),
        response: { 201: ref(WardStockRequest), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (request.replayOf !== null) {
        const row = request.idempotentId
          ? await findStockRequest(request.txClient, request.idempotentId)
          : null;
        if (!row) throw stayNotFound();
        await stayFor(request, row.admission_id, 'indent:create');
        return reply.status(201).send(stockRequestView(row));
      }
      await requireModules(request, 'inventory');
      const body = request.body as WardStockRequestCreate;
      const stay = await stayFor(request, request.params.admissionId, 'indent:create', true);
      openStay(stay);
      const userId = userIdOf(request);
      const indent = await requestIndent(request, body, userId);
      let id: string;
      try {
        id = await insertStockRequest(
          request.txClient,
          { indentId: indent.id, placeId: indent.fromLocationId, ...stayEvent(stay) },
          userId,
        );
      } catch (error) {
        throw stayRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'stock_indent', indent.id);
      request.audit('create', 'ward_stock_request', id);
      await request.emit('ward.stockrequested', id, {
        requestId: id,
        indentId: indent.id,
        placeId: indent.fromLocationId,
        ...stayEvent(stay),
      });
      const row = await findStockRequest(request.txClient, id);
      if (!row) throw new Error('request was not recorded');
      return reply.status(201).send(stockRequestView(row));
    },
  );
};
