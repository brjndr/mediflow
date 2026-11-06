import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { searchTerm, tidyLinesOptional, tidyOptional, tidyWithin } from '../../core/http/text.js';
import { medicineGenerics, medicineNamed } from '../drugs/index.js';
import type { Permission } from '../../core/access/registry.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { patientInScope } from '../patients/index.js';
import { tokenOfPatientToday } from '../queue/index.js';
import {
  findAllergen,
  findAllergies,
  findVitals,
  ageBasis,
  bandOf,
  dateAt,
  flagsFor,
  insertVitals,
  LATEST,
  listVitals,
  loadRangeRows,
  rangesAt,
  rangesVersion,
  replaceAllergies,
  saveRanges,
  searchCatalog,
  tableAt,
  UUID,
  type CatalogAllergen,
  type Flags,
  type RangeTable,
  type VitalsRow,
} from './repository.js';
import {
  ALLERGIES_MAX,
  AllergenPage,
  AllergenSearchRequest,
  AllergyList,
  AllergyListUpdate,
  COMPLAINT_MAX,
  CORRECTION_REASON_MAX,
  LIMITS,
  MEASURES,
  PatientParams,
  REACTION_MAX,
  SUBSTANCE_MAX,
  TRIAGE_SCHEMAS,
  VitalRangeTable,
  VitalRanges,
  Vitals,
  VitalsCreate,
  VitalsListQuery,
  VitalsPage,
  VitalsParams,
  type Allergy,
  type AllergyInput,
  type Measure,
  type VitalRangeTableBody,
  BANDS,
  RANGED,
} from './schemas.js';

const FEATURE = 'triage';
const READ = 'vitals:read';
const RECORD = 'vitals:record';
const ALLERGY_READ = 'allergy:read';
const ALLERGY_UPDATE = 'allergy:update';
const CONFIGURE = 'vitals:configure';

const invalid = (message: string) => new HttpError(400, 'validation_failed', message);
const patientNotFound = () => new HttpError(404, 'not_found', 'Patient not found');

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

/**
 * Whether the patient is the hospital's and within the scope the caller holds the route's
 * permission with, as the patients module decides it. Anything else is the same 404.
 */
const inScope = (request: FastifyRequest, patientId: string, permission: Permission) =>
  patientInScope(request.txClient, patientId, {
    scope: request.access.scope(permission),
    userId: userIdOf(request),
  });

const reading = (row: VitalsRow, flags: Flags) => ({
  id: row.id,
  tenantId: row.tenant_id,
  patientId: row.patient_id,
  ...(row.queue_token_id === null ? {} : { queueTokenId: row.queue_token_id }),
  ...(row.encounter_id === null ? {} : { encounterId: row.encounter_id }),
  recordedAt: row.recorded_at.toISOString(),
  recordedById: row.recorded_by,
  recordedByName: row.recorded_by_name,
  ...Object.fromEntries(
    MEASURES.flatMap((name) => (row[name] === null ? [] : [[name, row[name]]])),
  ),
  ...(row.chief_complaint === null ? {} : { chiefComplaint: row.chief_complaint }),
  ...(row.corrects_id === null ? {} : { correctsId: row.corrects_id }),
  ...(row.correction_reason === null ? {} : { correctionReason: row.correction_reason }),
  flags,
});

/** The readings of one patient, each with what was out of range when it was recorded (#378). */
async function readings(client: pg.ClientBase, patientId: string, rows: VitalsRow[]) {
  const basis = rows.length > 0 ? await ageBasis(client, patientId) : null;
  const ranges = basis ? await loadRangeRows(client) : [];
  return rows.map((row) => reading(row, basis ? flagsFor(basis, ranges, row) : {}));
}

/** The measurements of a body: whole numbers or one decimal, within what a body can be. */
function measuresOf(body: VitalsCreate): Partial<Record<Measure, number>> {
  const values = body as Partial<Record<Measure, number>>;
  const measures: Partial<Record<Measure, number>> = {};
  for (const name of MEASURES) {
    const value = values[name];
    if (value === undefined) continue;
    const { minimum, maximum } = LIMITS[name];
    // The schema checks the range; to one decimal is checked here, as JSON Schema's multipleOf
    // is not exact for decimals.
    if (value < minimum || value > maximum || Number(value.toFixed(1)) !== value) {
      throw invalid(`${name} is not a value the API takes`);
    }
    measures[name] = value;
  }
  if ((measures.systolic === undefined) !== (measures.diastolic === undefined)) {
    throw invalid('Systolic and diastolic go together');
  }
  if (
    measures.systolic !== undefined &&
    measures.diastolic !== undefined &&
    measures.diastolic >= measures.systolic
  ) {
    throw invalid('The diastolic is below the systolic');
  }
  return measures;
}

/** The refusal for a correction the unique index turned down, or the error itself. */
function correctionRefusal(error: unknown): unknown {
  const { code, constraint } = (error ?? {}) as { code?: unknown; constraint?: unknown };
  if (code === '23505' && constraint === 'vitals_corrected_once') {
    return new HttpError(422, 'already_corrected', 'The reading is already corrected');
  }
  return error;
}

/**
 * What an allergy that names a catalog entry or a medicine is stored as: the catalog's name and,
 * as it is now, what it covers. A snapshot, so changing the catalog later never changes a
 * recorded allergy. Null for free text; 422 `unknown_allergen` for an id the hospital cannot use.
 */
async function codedAllergy(
  client: pg.ClientBase,
  item: AllergyInput,
  previous: Allergy[],
): Promise<Pick<Allergy, 'substance' | 'kind' | 'allergenId' | 'drugId' | 'members'> | null> {
  const unknown = () => new HttpError(422, 'unknown_allergen', 'No such allergen');
  // One already on the list is kept as it was recorded, so editing the list never re-reads the
  // catalog for it: a medicine archived since, or a class changed, does not stop a save.
  const held = previous.find(
    (each) =>
      (item.allergenId !== undefined && each.allergenId === item.allergenId) ||
      (item.drugId !== undefined && each.drugId === item.drugId),
  );
  if (held?.kind !== undefined) {
    return {
      substance: held.substance,
      kind: held.kind,
      ...(held.allergenId === undefined ? {} : { allergenId: held.allergenId }),
      ...(held.drugId === undefined ? {} : { drugId: held.drugId }),
      members: held.members ?? [],
    };
  }
  if (item.allergenId !== undefined) {
    const found = await findAllergen(client, item.allergenId);
    if (!found) throw unknown();
    return {
      substance: found.name,
      kind: found.kind,
      allergenId: found.id,
      members: found.members,
    };
  }
  if (item.drugId !== undefined) {
    const found = await medicineNamed(client, item.drugId);
    if (!found) throw unknown();
    return {
      substance: tidyWithin(found.genericName, SUBSTANCE_MAX),
      kind: 'drug',
      drugId: found.id,
      members: [memberOf(found.genericName)],
    };
  }
  return null;
}

/**
 * A generic name as a member of an allergy: lower case, with anything that is not a letter, a
 * digit or a hyphen turned into a space, as the web app reads a medicine's names when it matches
 * them, so "Paracetamol (Acetaminophen)" still matches itself.
 */
const memberOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^\p{L}\p{N}-]+/gu, ' ')
    .trim();

type AllergenCursor = { n: string; r: 0 | 1; i: string };

const encodeAllergenCursor = (c: AllergenCursor) =>
  Buffer.from(JSON.stringify(c)).toString('base64url');

function decodeAllergenCursor(cursor: string): AllergenCursor | null {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { n, r, i } = value as Record<string, unknown>;
    if (typeof n !== 'string' || [...n].length > 150 || n.includes('\u0000')) return null;
    if ((r !== 0 && r !== 1) || typeof i !== 'string' || !UUID.test(i)) return null;
    return { n, r, i };
  } catch {
    return null;
  }
}

function allergyView(
  patientId: string,
  tenantId: string,
  row: Awaited<ReturnType<typeof findAllergies>>,
) {
  if (!row) return { patientId, tenantId, status: 'unknown' as const, items: [], version: 0 };
  return {
    patientId: row.patient_id,
    tenantId: row.tenant_id,
    status: row.status,
    items: row.items,
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    ...(row.updated_by_name === null ? {} : { updatedByName: row.updated_by_name }),
  };
}

export const triageRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of TRIAGE_SCHEMAS) app.addSchema(schema);

  const tenantIdOf = (request: FastifyRequest): string => {
    const id = request.tenant?.id;
    if (!id) throw new HttpError(409, 'no_active_tenant', 'Pick a hospital first');
    return id;
  };

  app.post(
    '/allergens/search',
    {
      config: { permissions: [ALLERGY_READ], feature: FEATURE },
      schema: {
        operationId: 'searchAllergens',
        tags: ['triage'],
        description:
          'What an allergy can name (#380): the catalog’s drug classes, foods and others, and the generic names of the hospital’s own medicines, by name, each once. Every word of `q` must be in the name. `kind` limits the search to one kind. It reads data only. What is searched for travels in the body, never in a query string: it is made while a patient’s allergies are open, and a term beside a patient id in an access log is patient data. The API does not log the body. Requires allergy:read and the triage feature flag. Not audited: it holds nothing about a patient. No `total`.',
        body: ref(AllergenSearchRequest),
        response: { 200: ref(AllergenPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as AllergenSearchRequest;
      const limit = body.limit ?? DEFAULT_PAGE_SIZE;
      const words = (searchTerm(body.q) ?? '').split(/\s+/).filter(Boolean);
      const cursor = body.cursor === undefined ? undefined : decodeAllergenCursor(body.cursor);
      if (cursor === null) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');

      const withCatalog = body.kind !== 'drug';
      const withDrugs = body.kind === undefined || body.kind === 'drug';
      const catalogKind = body.kind === 'drug' ? undefined : body.kind;
      const [catalog, generics] = await Promise.all([
        withCatalog
          ? searchCatalog(request.txClient, {
              words,
              ...(catalogKind === undefined ? {} : { kind: catalogKind }),
              ...(cursor
                ? { after: { name: cursor.n, id: cursor.i, fromCatalog: cursor.r === 0 } }
                : {}),
              limit: limit + 1,
            })
          : [],
        withDrugs
          ? medicineGenerics(request.txClient, {
              words,
              ...(cursor ? { after: { name: cursor.n, inclusive: cursor.r === 0 } } : {}),
              limit: limit + 1,
            })
          : [],
      ]);
      // Both are in name order, so the first limit + 1 of the two together are the page and one.
      const merged = [
        ...catalog.map((row) => ({ rank: 0 as const, row })),
        ...generics.map((row) => ({ rank: 1 as const, row })),
      ].sort(
        (a, b) =>
          (a.row.name_lower < b.row.name_lower
            ? -1
            : a.row.name_lower > b.row.name_lower
              ? 1
              : 0) ||
          a.rank - b.rank ||
          (a.row.id < b.row.id ? -1 : a.row.id > b.row.id ? 1 : 0),
      );
      const page = merged.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map(({ rank, row }) =>
          rank === 0
            ? { name: row.name, kind: (row as CatalogAllergen).kind, allergenId: row.id }
            : { name: row.name, kind: 'drug' as const, drugId: row.id },
        ),
        nextCursor:
          merged.length > limit && last
            ? encodeAllergenCursor({ n: last.row.name_lower, r: last.rank, i: last.row.id })
            : null,
      };
    },
  );

  app.get(
    '/patients/:patientId/vitals',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listVitals',
        tags: ['triage'],
        description:
          'The patient’s readings, newest first, corrections and the readings they correct included. Optionally only those taken for one queue token. A list, not a search: nothing typed in its address says anything about the patient, so it is a GET. A patient the hospital does not have is 404 `not_found`. Requires vitals:read and the triage feature flag. Every reading of a page is audited in the request’s transaction. `total` comes with the first page only.',
        params: PatientParams,
        querystring: VitalsListQuery,
        response: { 200: ref(VitalsPage), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      if (!(await inScope(request, patientId, READ))) throw patientNotFound();
      const { queueTokenId, cursor, limit = DEFAULT_PAGE_SIZE } = request.query;
      const page = await listVitals(request.txClient, patientId, {
        ...(queueTokenId === undefined ? {} : { queueTokenId }),
        ...(cursor === undefined ? {} : { cursor }),
        limit,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) request.audit('read', 'vitals', row.id);
      return {
        items: await readings(request.txClient, patientId, page.rows),
        nextCursor: page.nextCursor,
        ...(page.total === undefined ? {} : { total: page.total }),
      };
    },
  );

  app.post(
    '/patients/:patientId/vitals',
    {
      // A clinical answer is never kept a second time: only the new id, for a repeat.
      config: {
        permissions: [RECORD],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'recordVitals',
        tags: ['triage'],
        headers: RequiredIdempotencyHeaders,
        description:
          'Records a reading: at least one measurement or a chief complaint, the measurements whole numbers or to one decimal within what a body can be, systolic and diastolic together with the diastolic below the systolic (400 `validation_failed` otherwise). The token must be this patient’s and today’s at the hospital, in any status (a re-check after the consultation is allowed); otherwise 422 `token_not_for_patient`. A correction names a reading of this patient (422 `unknown_correction`) that no other reading corrects yet (422 `already_corrected`, decided by a unique index), with a reason, and takes that reading’s queueTokenId and encounterId: a queueTokenId sent with a correction, or a reason without one, is refused (400). A patient the hospital does not have is 404 `not_found`. The Idempotency-Key header is required and kept per hospital and user: a repeat records nothing and answers with the reading. Audited in the request’s transaction, and emits `vitals.recorded` through the outbox (the reading’s id, patientId, queueTokenId and correctsId when there are, the actor and the time). Requires vitals:record and the triage feature flag.',
        params: PatientParams,
        body: ref(VitalsCreate),
        response: { 201: ref(Vitals), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const { patientId } = request.params;
      if (!(await inScope(request, patientId, RECORD))) throw patientNotFound();
      if (request.replayOf !== null) {
        const recorded = request.idempotentId
          ? await findVitals(request.txClient, patientId, request.idempotentId)
          : null;
        if (!recorded) throw new HttpError(404, 'not_found', 'Reading not found');
        request.audit('read', 'vitals', recorded.id);
        return reply.status(201).send((await readings(request.txClient, patientId, [recorded]))[0]);
      }
      const body = request.body as VitalsCreate;
      const measures = measuresOf(body);
      const chiefComplaint = tidyLinesOptional(body.chiefComplaint, COMPLAINT_MAX);
      const correctionReason = tidyOptional(body.correctionReason, CORRECTION_REASON_MAX);
      if (Object.keys(measures).length === 0 && chiefComplaint === null) {
        throw invalid('A measurement or a chief complaint is needed');
      }
      if ((body.correctsId === undefined) !== (correctionReason === null)) {
        throw invalid('A correction and its reason go together');
      }
      if (body.correctsId !== undefined && body.queueTokenId !== undefined) {
        throw invalid('A correction takes the token of the reading it corrects');
      }

      let queueTokenId: string | null = null;
      let encounterId: string | null = null;
      if (body.correctsId !== undefined) {
        const corrected = await findVitals(request.txClient, patientId, body.correctsId);
        if (!corrected) throw new HttpError(422, 'unknown_correction', 'No such reading');
        queueTokenId = corrected.queue_token_id;
        encounterId = corrected.encounter_id;
      } else if (body.queueTokenId !== undefined) {
        if (!(await tokenOfPatientToday(request.txClient, body.queueTokenId, patientId))) {
          throw new HttpError(422, 'token_not_for_patient', 'Not this patient’s token today');
        }
        queueTokenId = body.queueTokenId;
      }

      let id: string;
      try {
        id = await insertVitals(
          request.txClient,
          {
            patientId,
            queueTokenId,
            encounterId,
            measures,
            chiefComplaint,
            correctsId: body.correctsId ?? null,
            correctionReason,
          },
          userIdOf(request),
        );
      } catch (error) {
        throw correctionRefusal(error);
      }
      request.idempotentId = id;
      request.audit('create', 'vitals', id);
      await request.emit('vitals.recorded', id, {
        vitalsId: id,
        patientId,
        ...(queueTokenId === null ? {} : { queueTokenId }),
        ...(body.correctsId === undefined ? {} : { correctsId: body.correctsId }),
      });
      const recorded = await findVitals(request.txClient, patientId, id);
      if (!recorded) throw new Error('reading was not recorded');
      return reply.status(201).send((await readings(request.txClient, patientId, [recorded]))[0]);
    },
  );

  app.get(
    '/patients/:patientId/vitals/:vitalsId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getVitals',
        tags: ['triage'],
        description:
          'One reading of the patient. A reading of another patient, of another hospital or of none is 404 `not_found`. Requires vitals:read and the triage feature flag. Audited.',
        params: VitalsParams,
        response: { 200: ref(Vitals), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      if (!(await inScope(request, request.params.patientId, READ))) {
        throw new HttpError(404, 'not_found', 'Reading not found');
      }
      const row = await findVitals(
        request.txClient,
        request.params.patientId,
        request.params.vitalsId,
      );
      if (!row) throw new HttpError(404, 'not_found', 'Reading not found');
      request.audit('read', 'vitals', row.id);
      return (await readings(request.txClient, request.params.patientId, [row]))[0];
    },
  );

  app.get(
    '/patients/:patientId/vital-ranges',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getVitalRanges',
        tags: ['triage'],
        description:
          'The hospital’s normal ranges that apply to this patient, decided by the server from the patient’s age band (infant, child, adolescent or adult) on today’s date at the hospital: the hospital’s own ranges for that band, or the built-in ones for a band it has set none for (#379). A patient the hospital does not have is 404 `not_found`. Audited, as it tells the patient’s age band. Requires vitals:read and the triage feature flag.',
        params: PatientParams,
        response: { 200: ref(VitalRanges), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      if (!(await inScope(request, patientId, READ))) throw patientNotFound();
      const basis = await ageBasis(request.txClient, patientId);
      if (!basis) throw patientNotFound();
      request.audit('read', 'vital_ranges', patientId);
      const now = new Date();
      const band = bandOf(basis.dob, dateAt(now, basis.timeZone));
      return { ranges: rangesAt(await loadRangeRows(request.txClient), band, LATEST) };
    },
  );

  app.get(
    '/vitals/ranges',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getVitalRangeTable',
        tags: ['triage'],
        description:
          'The hospital’s normal ranges for every age band as they apply now, with the version to send back when saving them. A band the hospital has set none for shows the built-in ranges. Requires vitals:read and the triage feature flag. Audited.',
        response: { 200: ref(VitalRangeTable), ...errors(401, 403, 409, 429) },
      },
    },
    async (request) => {
      request.audit('read', 'vital_ranges');
      return {
        version: await rangesVersion(request.txClient),
        bands: tableAt(await loadRangeRows(request.txClient), LATEST),
      };
    },
  );

  app.put(
    '/vitals/ranges',
    {
      config: { permissions: [CONFIGURE], feature: FEATURE },
      schema: {
        operationId: 'saveVitalRangeTable',
        tags: ['triage'],
        description:
          'Saves the hospital’s normal ranges for every age band, in effect from now on: readings already recorded keep the marks they had, because a reading is marked against the ranges in effect when it was recorded (#378). `version` is the one read with the ranges; if another save came first the answer is 409 `conflict` and nothing changes. A low limit that is not below its high limit, or a limit with more than one decimal, is 422 `invalid_range`. A measure with no limit in a band is not checked for it. Audited. Requires vitals:configure and the triage feature flag.',
        body: ref(VitalRangeTable),
        response: {
          200: ref(VitalRangeTable),
          ...errors(400, 401, 403, 409, 422, 429),
        },
      },
    },
    async (request) => {
      const body = request.body as VitalRangeTableBody;
      const table = {} as RangeTable;
      for (const band of BANDS) {
        table[band] = {};
        for (const measure of RANGED) {
          const limits = body.bands[band]?.[measure];
          if (!limits) continue;
          const { low, high } = limits;
          for (const limit of [low, high]) {
            if (limit !== undefined && Math.round(limit * 10) / 10 !== limit) {
              throw new HttpError(422, 'invalid_range', 'A limit has at most one decimal');
            }
          }
          if (low !== undefined && high !== undefined && low >= high) {
            throw new HttpError(422, 'invalid_range', 'A low limit must be below its high limit');
          }
          table[band][measure] = {
            ...(low === undefined ? {} : { low }),
            ...(high === undefined ? {} : { high }),
          };
        }
      }
      const saved = await saveRanges(request.txClient, userIdOf(request), table, body.version);
      if (!saved) throw new HttpError(409, 'conflict', 'The ranges were changed by someone else');
      request.audit('update', 'vital_ranges');
      return {
        version: await rangesVersion(request.txClient),
        bands: tableAt(await loadRangeRows(request.txClient), LATEST),
      };
    },
  );

  app.get(
    '/patients/:patientId/allergies',
    {
      config: { permissions: [ALLERGY_READ], feature: FEATURE },
      schema: {
        operationId: 'getAllergies',
        tags: ['triage'],
        description:
          'The patient’s allergies; status `unknown` and version 0 while never recorded, which is not the same as `none` (asked, no known allergies). A patient the hospital does not have is 404 `not_found`. Requires allergy:read and the triage feature flag. Audited.',
        params: PatientParams,
        response: { 200: ref(AllergyList), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      if (!(await inScope(request, patientId, ALLERGY_READ))) throw patientNotFound();
      request.audit('read', 'allergy_list', patientId);
      return allergyView(
        patientId,
        tenantIdOf(request),
        await findAllergies(request.txClient, patientId),
      );
    },
  );

  app.put(
    '/patients/:patientId/allergies',
    {
      config: { permissions: [ALLERGY_UPDATE], feature: FEATURE },
      schema: {
        operationId: 'setAllergies',
        tags: ['triage'],
        description: `Replaces the patient’s allergies whole, from the version the edit started from (0 while never recorded); another change first is 409 \`conflict\`, and nothing changes. \`none\` with no items, \`listed\` with 1 to ${ALLERGIES_MAX} (400 otherwise); substances and reactions are plain text, tidied. A patient the hospital does not have is 404 \`not_found\`. Requires allergy:update and the triage feature flag. Audited in the request’s transaction, and emits \`allergy.updated\` through the outbox (patientId and the new version; never the allergies themselves).`,
        params: PatientParams,
        body: ref(AllergyListUpdate),
        response: { 200: ref(AllergyList), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const { patientId } = request.params;
      const body = request.body as AllergyListUpdate;
      if (!(await inScope(request, patientId, ALLERGY_UPDATE))) throw patientNotFound();
      const previous = (await findAllergies(request.txClient, patientId))?.items ?? [];
      const items: Allergy[] = [];
      for (const item of body.items) {
        const reaction = tidyOptional(item.reaction, REACTION_MAX);
        const substance = tidyWithin(item.substance, SUBSTANCE_MAX);
        if (substance === '') throw invalid('A substance is needed');
        if (item.allergenId !== undefined && item.drugId !== undefined) {
          throw invalid('An allergy names a catalog entry or a medicine, not both');
        }
        const coded = await codedAllergy(request.txClient, item, previous);
        items.push({
          ...(coded ?? { substance }),
          ...(reaction === null ? {} : { reaction }),
          severity: item.severity,
        });
      }
      if ((body.status === 'none') !== (items.length === 0)) {
        throw invalid('`none` has no items and `listed` has at least one');
      }
      const replaced = await replaceAllergies(
        request.txClient,
        patientId,
        body.version,
        { status: body.status, items },
        userIdOf(request),
      );
      if (!replaced) throw new HttpError(409, 'conflict', 'Changed by someone else');
      const now = await findAllergies(request.txClient, patientId);
      if (!now) throw new Error('allergies were not saved');
      request.audit('update', 'allergy_list', patientId);
      await request.emit('allergy.updated', patientId, { patientId, version: now.version });
      return allergyView(patientId, tenantIdOf(request), now);
    },
  );
};
