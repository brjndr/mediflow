import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import { Type } from '@sinclair/typebox';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { IdempotencyHeaders } from '../../core/idempotency/schema.js';
import {
  drugExists,
  findDrug,
  insertDrug,
  isDrugExists,
  lockDrug,
  searchDrugs,
  setArchived,
  similarDrugs,
  updateDrug,
  type DrugDetails,
  type DrugRow,
} from './repository.js';
import {
  Drug,
  DRUG_SCHEMAS,
  DrugCreate,
  DrugDuplicateMatches,
  DrugDuplicateQuery,
  DrugPage,
  DrugSearchRequest,
  DrugUpdate,
  DUPLICATES_MAX,
} from './schemas.js';

const FEATURE = 'drugs';
const READ = 'drug:read';
const MANAGE = 'drug:manage';

const view = (row: DrugRow): Drug => ({
  id: row.id,
  tenantId: row.tenant_id,
  type: row.type,
  genericName: row.generic_name,
  ...(row.brand_name === null ? {} : { brandName: row.brand_name }),
  form: row.form,
  ...(row.strength === null ? {} : { strength: row.strength }),
  ...(row.unit === null ? {} : { unit: row.unit }),
  schedule: row.schedule,
  controlled: row.controlled,
  taxClass: row.tax_class,
  ...(row.reorder_level === null ? {} : { reorderLevel: row.reorder_level }),
  archived: row.archived,
  version: row.version,
});

const detailsOf = (row: DrugRow): DrugDetails => ({
  type: row.type,
  genericName: row.generic_name,
  brandName: row.brand_name,
  form: row.form,
  strength: row.strength,
  unit: row.unit,
  schedule: row.schedule,
  controlled: row.controlled,
  taxClass: row.tax_class,
  reorderLevel: row.reorder_level,
});

// One answer for an item that does not exist and one of another hospital.
const notFound = () => new HttpError(404, 'drug_not_found', 'No such item');
const exists = () => new HttpError(409, 'drug_exists', 'The hospital has exactly this item');

/** A name as it is stored: trimmed, and not empty once it is. */
function cleanName(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') throw new HttpError(400, 'validation_failed', 'A generic name is required');
  return trimmed;
}

/** Optional text is absent, never empty. */
const optional = (text: string | undefined): string | null => (text?.trim() ? text.trim() : null);

/** Schedule X and narcotic items are controlled, whatever was sent. */
const controlledFor = (details: DrugDetails): DrugDetails =>
  details.schedule === 'x' || details.schedule === 'narcotic'
    ? { ...details, controlled: true }
    : details;

const FIELDS = [
  'type',
  'genericName',
  'brandName',
  'form',
  'strength',
  'unit',
  'schedule',
  'controlled',
  'taxClass',
  'reorderLevel',
] as const satisfies readonly (keyof DrugDetails)[];

const OTHER_HOSPITAL =
  ' An item of another hospital answers 404 drug_not_found, the same as one that does not exist.';

export const drugRoutes: FastifyPluginAsyncTypebox = async (app) => {
  for (const schema of DRUG_SCHEMAS) app.addSchema(schema);

  const Params = Type.Object({ drugId: Type.String({ maxLength: 64 }) });

  app.post(
    '/drugs/search',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'searchDrugs',
        tags: ['drugs'],
        description:
          'The medicines and consumables of the active tenant, by generic name then brand. Every word of `q` must be in the generic name or the brand, in any order. A catalog can hold tens of thousands of items: there is no unpaged form, and `total` comes with the first page only. It reads data only. What is searched for travels in the body, never in a query string: the same search is made from prescribing, ordering and billing screens while a patient record is open, and a search term beside a patient id in an access log is patient data. The API does not log the body.',
        body: ref(DrugSearchRequest),
        response: { 200: ref(DrugPage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as DrugSearchRequest;
      const result = await searchDrugs(request.txClient, {
        q: body.q,
        type: body.type,
        form: body.form,
        schedule: body.schedule,
        controlled: body.controlled ?? false,
        archived: body.archived ?? false,
        cursor: body.cursor,
        limit: body.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!result) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      return {
        items: result.rows.map(view),
        nextCursor: result.nextCursor,
        ...(result.total === undefined ? {} : { total: result.total }),
      };
    },
  );

  app.post(
    '/drugs/duplicate-check',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'checkDrugDuplicates',
        tags: ['drugs'],
        description:
          'Finds items of the hospital, archived or not, that may be the one about to be added: the same generic name in the same form, whatever the brand or the strength, whatever the capitals. At most ten, by brand. It reads data only.',
        body: ref(DrugDuplicateQuery),
        response: { 200: ref(DrugDuplicateMatches), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as DrugDuplicateQuery;
      const rows = await similarDrugs(
        request.txClient,
        cleanName(body.genericName),
        body.form,
        DUPLICATES_MAX,
      );
      return { items: rows.map(view) };
    },
  );

  app.post(
    '/drugs',
    {
      // No patient data in the answer, so a replay can return it whole.
      config: { permissions: [MANAGE], feature: FEATURE, idempotent: { body: 'full' } },
      schema: {
        operationId: 'createDrug',
        tags: ['drugs'],
        headers: IdempotencyHeaders,
        description:
          "Adds an item. The hospital is the session's: the body carries no tenant. An item with the same generic name, brand, form and strength as one the hospital has, archived or not, whatever the capitals, is refused with 409 drug_exists. Items that are only similar are the caller's to judge: see the duplicate check. An optional field (brand, strength, unit) is left out when there is none. Audited.",
        body: ref(DrugCreate),
        response: { 201: ref(Drug), ...errors(400, 401, 403, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      const body = request.body as DrugCreate;
      const details = controlledFor({
        type: body.type,
        genericName: cleanName(body.genericName),
        brandName: optional(body.brandName),
        form: body.form,
        strength: optional(body.strength),
        unit: optional(body.unit),
        schedule: body.schedule,
        controlled: body.controlled ?? false,
        taxClass: body.taxClass,
        reorderLevel: body.reorderLevel ?? null,
      });
      if (await drugExists(request.txClient, details)) throw exists();
      let row: DrugRow;
      try {
        row = await insertDrug(request.txClient, details);
      } catch (error) {
        // Two requests for the same new item at once: the database lets one through.
        if (isDrugExists(error)) throw exists();
        throw error;
      }
      request.audit('create', 'drug', row.id);
      await request.emit('master.changed', row.id, { kind: 'drug', change: 'created' });
      return reply.status(201).send(view(row));
    },
  );

  app.get(
    '/drugs/:drugId',
    {
      config: { permissions: [READ], feature: FEATURE },
      schema: {
        operationId: 'getDrug',
        tags: ['drugs'],
        description: 'One item.' + OTHER_HOSPITAL,
        params: Params,
        response: { 200: ref(Drug), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const row = await findDrug(request.txClient, request.params.drugId);
      if (!row) throw notFound();
      return view(row);
    },
  );

  app.patch(
    '/drugs/:drugId',
    {
      config: { permissions: [MANAGE], feature: FEATURE },
      schema: {
        operationId: 'updateDrug',
        tags: ['drugs'],
        description:
          'Changes an item. Send the version the change was made from: 409 conflict when the item has changed since, 409 drug_exists when the change would make it the same as another. Empty text removes a brand, a strength or a unit, and a null reorder level removes the level. Sending what the item already has changes nothing. Every change is audited with who made it, and the event names the fields that changed; a change of `schedule` or `controlled` is audited as `reclassify`, so taking an item out of a controlled schedule leaves its own trace. Records that name an item keep what it was: a dispense, a stock entry and a prescription line store the generic name, brand, form, strength, schedule and controlled flag as they were when the line was written, so renaming or reclassifying an item never changes history.' +
          OTHER_HOSPITAL,
        params: Params,
        body: ref(DrugUpdate),
        response: { 200: ref(Drug), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const body = request.body as DrugUpdate;
      // Locked while the versions are compared, so of two changes made from the same version
      // exactly one goes through.
      const current = await lockDrug(request.txClient, request.params.drugId);
      if (!current) throw notFound();
      if (current.version !== body.expectedVersion) {
        throw new HttpError(409, 'conflict', 'The item has changed');
      }
      const before = detailsOf(current);
      const text = (sent: string | undefined, now: string | null) =>
        sent === undefined ? now : optional(sent);
      const next = controlledFor({
        type: body.type ?? before.type,
        genericName:
          body.genericName === undefined ? before.genericName : cleanName(body.genericName),
        brandName: text(body.brandName, before.brandName),
        form: body.form ?? before.form,
        strength: text(body.strength, before.strength),
        unit: text(body.unit, before.unit),
        schedule: body.schedule ?? before.schedule,
        controlled: body.controlled ?? before.controlled,
        taxClass: body.taxClass ?? before.taxClass,
        reorderLevel: body.reorderLevel === undefined ? before.reorderLevel : body.reorderLevel,
      });
      const changed = FIELDS.filter((field) => next[field] !== before[field]);
      if (changed.length === 0) return view(current);
      // The database decides what "the same" is, and an item is never in the way of itself.
      if (await drugExists(request.txClient, next, current.id)) throw exists();
      let row: DrugRow;
      try {
        row = await updateDrug(request.txClient, current.id, next);
      } catch (error) {
        if (isDrugExists(error)) throw exists();
        throw error;
      }
      const reclassified = changed.includes('schedule') || changed.includes('controlled');
      request.audit(reclassified ? 'reclassify' : 'update', 'drug', row.id);
      // The names of the fields, never their values.
      await request.emit('master.changed', row.id, {
        kind: 'drug',
        change: 'updated',
        fields: changed,
      });
      return view(row);
    },
  );

  for (const action of ['archive', 'restore'] as const) {
    app.post(
      `/drugs/:drugId/${action}`,
      {
        config: { permissions: [MANAGE], feature: FEATURE },
        schema: {
          operationId: `${action}Drug`,
          tags: ['drugs'],
          description:
            (action === 'archive'
              ? 'Archives an item: it stays on the stock, prescriptions and bills that name it and is no longer offered for new ones.'
              : 'Brings an archived item back.') +
            ' Doing it twice changes nothing. Audited.' +
            OTHER_HOSPITAL,
          params: Params,
          response: { 200: ref(Drug), ...errors(401, 403, 404, 409, 429) },
        },
      },
      async (request) => {
        const current = await lockDrug(request.txClient, request.params.drugId);
        if (!current) throw notFound();
        const changed = await setArchived(request.txClient, current.id, action === 'archive');
        if (changed) {
          request.audit(action, 'drug', changed.id);
          await request.emit('master.changed', changed.id, {
            kind: 'drug',
            change: action === 'archive' ? 'archived' : 'restored',
          });
        }
        return view(changed ?? current);
      },
    );
  }
};
