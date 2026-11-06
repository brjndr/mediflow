import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyLinesOptional, tidyWithin } from '../../core/http/text.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import { INSTRUCTIONS_MAX } from '../clinical/index.js';
import { medicineLabels, prescribableDrug } from '../drugs/index.js';
import {
  favouriteIds,
  findSet,
  insertSet,
  isNameTaken,
  linesOf,
  listSets,
  nameTaken,
  replaceFavourites,
  replaceLines,
  updateSet,
  type SetRow,
} from './repository.js';
import {
  FavouriteDrugs,
  FavouriteDrugsSet,
  NAME_MAX,
  PRESCRIPTION_SET_SCHEMAS,
  PrescriptionSetCreate,
  PrescriptionSetDetail,
  PrescriptionSetListQuery,
  PrescriptionSetPage,
  PrescriptionSetUpdate,
  type PrescriptionSet,
  type PrescriptionSetLine,
} from './schemas.js';

const FEATURE = 'clinical';
const READ = 'prescriptionSet:read';
const MANAGE = 'prescriptionSet:manage';
const SHARED = 'prescriptionSet:manageShared';

const view = (row: SetRow): PrescriptionSet => ({
  id: row.id,
  tenantId: row.tenant_id,
  name: row.name,
  shared: row.owner_user_id === null,
  lineCount: row.line_count,
  archived: row.archived,
  version: row.version,
  updatedAt: row.updated_at.toISOString(),
});

// One answer for a set that does not exist, one of another hospital and another doctor's own.
const notFound = () => new HttpError(404, 'prescription_set_not_found', 'No such prescription set');
const taken = () =>
  new HttpError(409, 'prescription_set_name_taken', 'A set of yours or a shared one has that name');
const invalid = (message: string) => new HttpError(400, 'validation_failed', message);

const userOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'Sign in first');
  return userId;
};

const cleanName = (name: string): string => {
  const tidied = tidyWithin(name, NAME_MAX);
  if (tidied === '') throw invalid('A name is required');
  return tidied;
};

async function mayShare(request: FastifyRequest): Promise<boolean> {
  const policy = await request.access.policy();
  return policy?.permissions.some((grant) => grant.permission === SHARED) ?? false;
}

/** The lines tidied, and every medicine one that may be prescribed (422 otherwise). */
async function cleanLines(
  request: FastifyRequest,
  lines: readonly PrescriptionSetLine[],
): Promise<PrescriptionSetLine[]> {
  const clean: PrescriptionSetLine[] = [];
  for (const line of lines) {
    const dose = tidyWithin(line.dose, 50);
    const frequency = tidyWithin(line.frequency, 50);
    if (dose === '' || frequency === '') throw invalid('A line needs a dose and a frequency');
    const instructions = tidyLinesOptional(line.instructions, INSTRUCTIONS_MAX);
    if (!(await prescribableDrug(request.txClient, line.drugId))) {
      throw new HttpError(422, 'unknown_drug', 'No such medicine');
    }
    clean.push({ ...line, dose, frequency, instructions: instructions ?? undefined });
  }
  return clean;
}

async function detail(request: FastifyRequest, row: SetRow) {
  const lines = await linesOf(request.txClient, row.id);
  const labels = await medicineLabels(
    request.txClient,
    lines.map((line) => line.drug_id),
  );
  return {
    set: view(row),
    lines: lines.map((line) => ({
      drugId: line.drug_id,
      drugName: labels.get(line.drug_id)?.name ?? '',
      drugArchived: labels.get(line.drug_id)?.archived ?? true,
      genericName: labels.get(line.drug_id)?.genericName ?? '',
      ...(labels.get(line.drug_id)?.brandName
        ? { brandName: labels.get(line.drug_id)?.brandName }
        : {}),
      dose: line.dose,
      route: line.route,
      frequency: line.frequency,
      ...(line.duration_days === null ? {} : { durationDays: line.duration_days }),
      ...(line.quantity === null ? {} : { quantity: line.quantity }),
      ...(line.instructions === null ? {} : { instructions: line.instructions }),
    })),
  };
}

async function favourites(request: FastifyRequest) {
  const ids = await favouriteIds(request.txClient, userOf(request));
  const labels = await medicineLabels(request.txClient, ids);
  return {
    items: ids.map((drugId) => ({
      drugId,
      name: labels.get(drugId)?.name ?? '',
      archived: labels.get(drugId)?.archived ?? true,
    })),
  };
}

const NOT_VISIBLE =
  ' A set of another hospital, or another doctor’s own, answers 404 prescription_set_not_found, the same as one that does not exist.';

export const prescriptionSetRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of PRESCRIPTION_SET_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ setId: Type.String({ maxLength: 64 }) });

  app.get(
    '/prescription-sets',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'listPrescriptionSets',
        tags: ['prescription-sets'],
        description:
          'The prescription sets the caller may use: those shared with the hospital and their own, by name. Requires prescriptionSet:read and the clinical feature flag. `total` comes with the first page only.',
        querystring: PrescriptionSetListQuery,
        response: { 200: ref(PrescriptionSetPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const { cursor, limit = DEFAULT_PAGE_SIZE, archived = false } = request.query;
      const list = await listSets(request.txClient, userOf(request), { archived, cursor, limit });
      if (!list) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: list.rows.map(view),
        nextCursor: list.nextCursor,
        ...(list.total === undefined ? {} : { total: list.total }),
      };
    },
  );

  app.post(
    '/prescription-sets',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE, idempotent: { body: 'none' } },
      schema: {
        operationId: 'createPrescriptionSet',
        tags: ['prescription-sets'],
        headers: IdempotencyHeaders,
        description:
          'Adds a prescription set: the caller’s own, or shared with the hospital when `shared` is true (needs prescriptionSet:manageShared, else 403 permission_denied). One to 30 lines, each a medicine of the catalog that may be prescribed (422 unknown_drug otherwise). A name another set of the same owner (or another shared set) has, archived or not, whatever the capitals, is 409 prescription_set_name_taken. Requires prescriptionSet:manage and prescriptionSet:read. A set holds no patient data. Audited. A repeat with the same Idempotency-Key adds nothing and answers with the set as it is now.',
        body: ref(PrescriptionSetCreate),
        response: { 201: ref(PrescriptionSetDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const userId = userOf(request);
      const sent = request.body as PrescriptionSetCreate;
      if (request.replayOf !== null) {
        const added = request.idempotentId
          ? await findSet(request.txClient, userId, request.idempotentId)
          : null;
        if (!added) throw notFound();
        return reply.status(201).send(await detail(request, added));
      }
      const shared = sent.shared === true;
      if (shared && !(await mayShare(request))) {
        throw new HttpError(403, 'permission_denied', 'Sharing a set needs more access');
      }
      const name = cleanName(sent.name);
      const lines = await cleanLines(request, sent.lines);
      const ownerId = shared ? null : userId;
      if (await nameTaken(request.txClient, { name, ownerId })) throw taken();
      let id: string;
      try {
        id = await insertSet(request.txClient, { name, ownerId });
      } catch (error) {
        if (isNameTaken(error)) throw taken();
        throw error;
      }
      await replaceLines(request.txClient, id, lines);
      request.idempotentId = id;
      request.audit('create', 'prescription_set', id);
      const row = await findSet(request.txClient, userId, id);
      if (!row) throw notFound();
      return reply.status(201).send(await detail(request, row));
    },
  );

  app.get(
    '/prescription-sets/:setId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getPrescriptionSet',
        tags: ['prescription-sets'],
        description:
          'One set with its lines. A medicine archived since is flagged `drugArchived`, not dropped. Requires prescriptionSet:read.' +
          NOT_VISIBLE,
        params: Params,
        response: { 200: ref(PrescriptionSetDetail), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findSet(request.txClient, userOf(request), request.params.setId);
      if (!row) throw notFound();
      return detail(request, row);
    },
  );

  app.patch(
    '/prescription-sets/:setId',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'updatePrescriptionSet',
        tags: ['prescription-sets'],
        description:
          'Renames a set, replaces its lines, archives it or restores it: send only what changes, with the `version` the change was made from (409 conflict otherwise). A shared set needs prescriptionSet:manageShared (403 permission_denied); an own set is its owner’s. Requires prescriptionSet:manage and prescriptionSet:read. Audited.' +
          NOT_VISIBLE,
        params: Params,
        body: ref(PrescriptionSetUpdate),
        response: { 200: ref(PrescriptionSetDetail), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const userId = userOf(request);
      const sent = request.body as PrescriptionSetUpdate;
      const row = await findSet(request.txClient, userId, request.params.setId, { lock: true });
      if (!row) throw notFound();
      if (row.owner_user_id === null && !(await mayShare(request))) {
        throw new HttpError(403, 'permission_denied', 'A shared set needs more access');
      }
      if (row.version !== sent.version) {
        throw new HttpError(409, 'conflict', 'A newer version has been saved');
      }
      const name = sent.name === undefined ? undefined : cleanName(sent.name);
      const lines = sent.lines === undefined ? undefined : await cleanLines(request, sent.lines);
      if (name !== undefined && name !== row.name) {
        const clash = await nameTaken(request.txClient, {
          name,
          ownerId: row.owner_user_id,
          exceptId: row.id,
        });
        if (clash) throw taken();
      }
      try {
        await updateSet(request.txClient, row.id, { name, archived: sent.archived });
      } catch (error) {
        if (isNameTaken(error)) throw taken();
        throw error;
      }
      if (lines) await replaceLines(request.txClient, row.id, lines);
      request.audit('update', 'prescription_set', row.id);
      const saved = await findSet(request.txClient, userId, row.id);
      if (!saved) throw notFound();
      return detail(request, saved);
    },
  );

  app.get(
    '/me/favourite-drugs',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getFavouriteDrugs',
        tags: ['prescription-sets'],
        description:
          'The medicines the caller starred, in the order they put them (at most 20). A medicine archived since is flagged. Requires prescriptionSet:read.',
        response: { 200: ref(FavouriteDrugs), ...errors(401, 403, 409, 429) },
      },
    },
    async (request) => favourites(request),
  );

  app.put(
    '/me/favourite-drugs',
    {
      config: { permissions: [MANAGE, READ], feature: FEATURE },
      schema: {
        operationId: 'setFavouriteDrugs',
        tags: ['prescription-sets'],
        description:
          'Replaces the caller’s favourite medicines with this list, in order (at most 20, each a medicine of the catalog that may be prescribed, none twice: 422 unknown_drug otherwise). Requires prescriptionSet:manage and prescriptionSet:read. Favourites belong to the caller alone.',
        body: ref(FavouriteDrugsSet),
        response: { 200: ref(FavouriteDrugs), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request) => {
      const userId = userOf(request);
      const { drugIds } = request.body as FavouriteDrugsSet;
      if (new Set(drugIds).size !== drugIds.length) {
        throw new HttpError(422, 'unknown_drug', 'A medicine is listed twice');
      }
      for (const id of drugIds) {
        if (!(await prescribableDrug(request.txClient, id))) {
          throw new HttpError(422, 'unknown_drug', 'No such medicine');
        }
      }
      await replaceFavourites(request.txClient, userId, drugIds);
      request.audit('update', 'favourite_drugs');
      return favourites(request);
    },
  );
};
