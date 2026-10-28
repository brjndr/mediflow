import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Type } from '@sinclair/typebox';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import { DEFAULT_PAGE_SIZE, errors, ref } from '../../core/http/schemas.js';
import { tidyOptional, tidyWithin } from '../../core/http/text.js';
import { RequiredIdempotencyHeaders } from '../../core/idempotency/schema.js';
import { registerDrug, saleableDrug, type DispensableDrug } from '../drugs/index.js';
import { stockIn, stockOut, usableBatches } from '../inventory/index.js';
import { patientInScope } from '../patients/index.js';
import { isUuid } from './repository.js';
import {
  findSale,
  insertSale,
  insertSaleLine,
  insertSaleReturn,
  insertSaleReturnLine,
  listRegister,
  listSales,
  lockSale,
  saleOfReturn,
  todayAtHospital,
  type RegisterRow,
  type SaleListRow,
  type SaleRow,
} from './sales-repository.js';
import {
  inRegister,
  needsPrescription,
  PharmacySale,
  PRESCRIBER_NAME_MAX,
  PRESCRIBER_REGISTRATION_MAX,
  REGISTER_DAYS_MAX,
  RegisterPage,
  RegisterQuery,
  SaleCreate,
  SaleItemOptions,
  SaleItemOptionsQuery,
  SalePage,
  SaleReturnCreate,
  SALES_DAYS_DEFAULT,
  SalesQuery,
  type RegisterEntry,
  type SaleListItem,
} from './sales-schemas.js';
import { QUANTITY_MAX, REASON_MAX } from './schemas.js';

const FEATURE = 'pharmacy';
const SALE_READ = 'sale:read';
const SALE_CREATE = 'sale:create';
const SALE_RETURN = 'sale:return';
const REGISTER_READ = 'drugRegister:read';
const PATIENT_READ = 'patient:read';

const saleNotFound = () => new HttpError(404, 'sale_not_found', 'No such sale');

const optional = <Key extends string, Value>(key: Key, value: Value | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

const saleView = (row: SaleRow): PharmacySale => ({
  id: row.id,
  locationId: row.location_id,
  locationName: row.location_name,
  ...optional('patientId', row.patient_id),
  ...optional('patientName', row.patient_name),
  ...optional('patientMrn', row.patient_mrn),
  ...optional('prescriberName', row.prescriber_name),
  ...optional('prescriberRegistration', row.prescriber_registration),
  ...optional('prescribedOn', row.prescribed_on),
  totalMinor: row.total_minor,
  returnedMinor: row.returned_minor,
  soldAt: row.sold_at.toISOString(),
  soldByName: row.sold_by_name,
  lines: row.lines,
  returns: row.returns.map((each) => ({
    ...each,
    returnedAt: new Date(each.returnedAt).toISOString(),
  })),
});

const saleListView = (row: SaleListRow): SaleListItem => ({
  id: row.id,
  soldAt: row.sold_at.toISOString(),
  soldByName: row.sold_by_name,
  locationName: row.location_name,
  ...optional('patientId', row.patient_id),
  ...optional('patientName', row.patient_name),
  ...optional('patientMrn', row.patient_mrn),
  lineCount: row.line_count,
  totalMinor: row.total_minor,
  returnedMinor: row.returned_minor,
});

const registerView = (row: RegisterRow): RegisterEntry => ({
  id: row.id,
  at: row.at.toISOString(),
  locationName: row.location_name,
  batchNumber: row.batch_number,
  expiryDate: row.expiry_date,
  quantity: row.quantity,
  balanceAfter: row.balance_after,
  source: row.source,
  sourceId: row.source_id,
  reason: row.reason,
  actorName: row.actor_name,
  ...optional('patientId', row.patient_id),
  ...optional('patientName', row.patient_name),
  ...optional('patientMrn', row.patient_mrn),
  ...optional('prescriptionId', row.prescription_id),
  ...optional('prescriberName', row.prescriber_name),
  ...optional('prescriberRegistration', row.prescriber_registration),
});

const SaleParams = Type.Object({ saleId: Type.String() });

/** A calendar date `YYYY-MM-DD` that exists: 2026-02-30 does not, though `Date` rolls it on. */
const isCalendarDate = (day: string) => {
  const at = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === day;
};

/** Days between two calendar dates, `YYYY-MM-DD`: negative when the second is earlier. */
const daysBetween = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * Counter sales (#101): items sold at a place without an in-hospital prescription, their returns,
 * and the drug register of every movement of a register item. Registered inside the pharmacy's
 * routes, so it shares their schemas.
 */
export const saleRoutes: FastifyPluginAsyncTypebox = async (app) => {
  /** As dispensing: the pharmacy sells for the whole hospital, so only the scope `all` reaches. */
  const reaches = (request: FastifyRequest, permission: Permission) =>
    request.access.scope(permission) === 'all';

  /** The sale as it is now, audited as a read. */
  async function saleAnswer(request: FastifyRequest, saleId: string): Promise<PharmacySale> {
    const row = await findSale(request.txClient, saleId);
    if (!row) throw saleNotFound();
    request.audit('read', 'pharmacy_sale', row.id);
    return saleView(row);
  }

  /** A registered patient the caller may read, within that scope, or 422. */
  async function requireReadablePatient(request: FastifyRequest, patientId: string) {
    const policy = await request.access.policy();
    const reads = policy?.permissions.find((grant) => grant.permission === PATIENT_READ);
    const readable =
      reads !== undefined &&
      (await patientInScope(request.txClient, patientId, {
        scope: reads.scope ?? 'all',
        userId: userIdOf(request),
      }));
    if (!readable) throw new HttpError(422, 'unknown_patient', 'No such patient');
  }

  app.get(
    '/pharmacy/sale-options',
    {
      config: { permissions: [SALE_CREATE], feature: FEATURE },
      schema: {
        operationId: 'getSaleItemOptions',
        tags: ['pharmacy'],
        description:
          'An item that may be sold at a place (medicine or consumable, in use): whether it needs a prescription and is in the drug register, and its batches in date with stock there, nearest expiry first. Holds stock, no patient. Requires sale:create with the scope `all` and the pharmacy feature flag.',
        querystring: SaleItemOptionsQuery,
        response: { 200: ref(SaleItemOptions), ...errors(400, 401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query as { drugId: string; locationId: string };
      const notFound = () => new HttpError(404, 'item_not_found', 'No such item');
      if (!reaches(request, SALE_CREATE)) throw notFound();
      const item = await saleableDrug(request.txClient, query.drugId);
      if (!item) throw notFound();
      const batches = await usableBatches(request.txClient, [item.id], query.locationId);
      return {
        drugId: item.id,
        name: item.name,
        schedule: item.schedule,
        controlled: item.controlled,
        needsPrescription: needsPrescription(item),
        inRegister: inRegister(item),
        batches: batches.map((batch) => ({
          batchId: batch.batchId,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          onHand: batch.onHand,
          ...optional('mrpMinor', batch.mrpMinor),
        })),
      };
    },
  );

  /** A repeat of a sale or a return: the sale as it is now, audited as a read. */
  async function replaySale(request: FastifyRequest, reply: FastifyReply, saleId: string | null) {
    if (!saleId) throw saleNotFound();
    return reply.status(201).send(await saleAnswer(request, saleId));
  }

  app.post(
    '/pharmacy/sales',
    {
      config: {
        permissions: [SALE_CREATE, SALE_READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createSale',
        tags: ['pharmacy'],
        description:
          'Sells items at the counter (#101) from batches at a place, each at its batch’s maximum retail price: the units leave stock through the ledger (reason `sale`). An item of schedule H, H1, X, narcotic or controlled is sold only to a registered patient (`patientId`, one the caller may read: 422 `unknown_patient`) against an outside prescription recorded on the sale (prescriber’s name, registration number and date; 422 `prescription_required`). Every movement of an H1, X, narcotic or controlled item is in the drug register (`GET /pharmacy/register`). Refused: an item not in use (422 `unknown_item`) or given twice, a batch with no price (409 `no_price`), a place not in use (422 `unknown_location`), a batch not of the item (422 `unknown_batch`) or given twice, an expired batch (409 `batch_expired`), more than a batch holds (409 `insufficient_stock`). Emits `pharmacy.sold`, and `stock.low` when an item reaches its reorder level. The Idempotency-Key header is required: a repeat moves no stock and answers with the sale as it is now. Requires sale:create and sale:read with the scope `all` and the pharmacy feature flag. Audited.',
        headers: RequiredIdempotencyHeaders,
        body: ref(SaleCreate),
        response: { 201: ref(PharmacySale), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (!reaches(request, SALE_CREATE) || !reaches(request, SALE_READ)) {
        throw new HttpError(403, 'permission_denied', 'Selling needs the scope all');
      }
      if (request.replayOf !== null) return replaySale(request, reply, request.idempotentId);
      const body = request.body as SaleCreate;
      const client = request.txClient;
      const actorId = userIdOf(request);
      const drugIds = body.lines.map((line) => line.drugId.toLowerCase());
      if (new Set(drugIds).size !== drugIds.length) {
        throw new HttpError(422, 'unknown_item', 'An item is given once in a sale');
      }
      for (const line of body.lines) {
        const batchIds = line.batches.map((batch) => batch.batchId.toLowerCase());
        if (new Set(batchIds).size !== batchIds.length) {
          throw new HttpError(422, 'unknown_batch', 'A batch is given once in a sale');
        }
        const units = line.batches.reduce((sum, batch) => sum + batch.quantity, 0);
        if (units > QUANTITY_MAX) {
          throw new HttpError(400, 'validation_failed', `At most ${QUANTITY_MAX} units of an item`);
        }
      }
      const prescriberName = tidyOptional(body.prescriberName, PRESCRIBER_NAME_MAX);
      const prescriberRegistration = tidyOptional(
        body.prescriberRegistration,
        PRESCRIBER_REGISTRATION_MAX,
      );
      const prescribedOn = body.prescribedOn ?? null;
      const given = [prescriberName, prescriberRegistration, prescribedOn].filter(
        (value) => value !== null,
      ).length;
      if (given !== 0 && given !== 3) {
        throw new HttpError(400, 'validation_failed', 'A prescription is recorded whole');
      }
      if (prescribedOn !== null) {
        if (!isCalendarDate(prescribedOn)) {
          throw new HttpError(400, 'validation_failed', 'Not a date');
        }
        if (prescribedOn > (await todayAtHospital(client))) {
          throw new HttpError(400, 'validation_failed', 'A prescription is not dated ahead');
        }
      }
      const patientId = body.patientId?.toLowerCase() ?? null;
      if (patientId !== null) await requireReadablePatient(request, patientId);
      if (prescriberName !== null && patientId === null) {
        throw new HttpError(422, 'prescription_required', 'A prescription is of a patient');
      }

      const items = new Map<string, DispensableDrug>();
      for (const id of drugIds) {
        const item = await saleableDrug(client, id);
        if (!item) throw new HttpError(422, 'unknown_item', 'No such item in use');
        if (needsPrescription(item) && (patientId === null || prescriberName === null)) {
          throw new HttpError(
            422,
            'prescription_required',
            'The item is sold against a prescription to a patient',
          );
        }
        items.set(id, item);
      }
      const prices = new Map<string, bigint>();
      const batches = await usableBatches(client, drugIds, body.locationId);
      for (const batch of batches) {
        if (batch.mrpMinor !== null) prices.set(batch.batchId, BigInt(batch.mrpMinor));
      }

      // Stock goes out item by item in the order of their ids, so two sales of the same items
      // take inventory's per-item locks in one order.
      const saleId = randomUUID();
      const lines = [...body.lines]
        .map((line) => ({ ...line, drugId: line.drugId.toLowerCase() }))
        .sort((a, b) => (a.drugId < b.drugId ? -1 : a.drugId > b.drugId ? 1 : 0));
      const written: Parameters<typeof insertSaleLine>[1][] = [];
      let total = 0n;
      for (const line of lines) {
        const item = items.get(line.drugId);
        if (!item) throw new HttpError(422, 'unknown_item', 'No such item in use');
        const posted = await stockOut(request, {
          locationId: body.locationId,
          drugId: item.id,
          reorderLevel: item.reorderLevel,
          source: 'sale',
          sourceId: saleId,
          reason: 'sale',
          actorId,
          lines: line.batches.map((batch) => ({
            batchId: batch.batchId.toLowerCase(),
            quantity: batch.quantity,
          })),
        });
        for (const each of posted) {
          // Every batch here passed `stockOut`, so in date with stock: only its price can lack.
          const price = prices.get(each.batchId);
          if (price === undefined) {
            throw new HttpError(409, 'no_price', 'The batch has no price to sell at');
          }
          total += price * BigInt(each.quantity);
          written.push({
            saleId,
            lineNumber: 0,
            drugId: item.id,
            itemName: item.name,
            schedule: item.schedule,
            controlled: item.controlled,
            batchId: each.batchId,
            quantity: each.quantity,
            unitPriceMinor: price,
            ledgerEntryId: each.ledgerEntryId,
          });
        }
      }
      await insertSale(client, {
        id: saleId,
        locationId: body.locationId,
        patientId,
        prescriberName,
        prescriberRegistration,
        prescribedOn,
        totalMinor: total,
        soldBy: actorId,
      });
      for (const [index, line] of written.entries()) {
        await insertSaleLine(client, { ...line, lineNumber: index + 1 });
      }
      request.idempotentId = saleId;
      request.audit('create', 'pharmacy_sale', saleId);
      await request.emit('pharmacy.sold', saleId, {
        saleId,
        locationId: body.locationId,
        ...optional('patientId', patientId),
      });
      return reply.status(201).send(await saleAnswer(request, saleId));
    },
  );

  app.get(
    '/pharmacy/sales',
    {
      config: { permissions: [SALE_READ], feature: FEATURE },
      schema: {
        operationId: 'listSales',
        tags: ['pharmacy'],
        description:
          'The hospital’s counter sales sold within `days` at the hospital (default 7, at most 90), the newest first, each with the patient when one was named (name and MRN), its total and what was returned. `total` with the first page. Every sale with a patient listed is audited as read. Requires sale:read with the scope `all` (a narrower one sees nothing) and the pharmacy feature flag. Holds no patient term: a GET.',
        querystring: SalesQuery,
        response: { 200: ref(SalePage), ...errors(400, 401, 403, 409, 429) },
      },
    },
    async (request) => {
      const query = request.query as SalesQuery;
      if (!reaches(request, SALE_READ)) return { items: [], nextCursor: null, total: 0 };
      const page = await listSales(request.txClient, {
        days: query.days ?? SALES_DAYS_DEFAULT,
        ...optional('cursor', query.cursor),
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) {
        if (row.patient_id) request.audit('read', 'pharmacy_sale', row.id);
      }
      return {
        items: page.rows.map(saleListView),
        nextCursor: page.nextCursor,
        ...optional('total', page.total),
      };
    },
  );

  app.get(
    '/pharmacy/sales/:saleId',
    {
      config: { permissions: [SALE_READ], feature: FEATURE },
      schema: {
        operationId: 'getSale',
        tags: ['pharmacy'],
        description:
          'A counter sale with its lines (each with the units returned so far) and its returns, oldest first. Audited. Requires sale:read with the scope `all` and the pharmacy feature flag.',
        params: SaleParams,
        response: { 200: ref(PharmacySale), ...errors(401, 403, 404, 409, 429) },
      },
    },
    async (request) => {
      if (!reaches(request, SALE_READ)) throw saleNotFound();
      return saleAnswer(request, request.params.saleId);
    },
  );

  app.post(
    '/pharmacy/sales/:saleId/returns',
    {
      config: {
        permissions: [SALE_RETURN, SALE_READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'createSaleReturn',
        tags: ['pharmacy'],
        description:
          'Brings units of a sale back into stock at the sale’s place, through the ledger (reason `sale_return`), with a reason. Each line of the sale once (422 `unknown_line` for one not of the sale or given twice), never more than was sold less what was returned before (409 `over_return`). Refused for a batch expired at the hospital today (409 `batch_expired`: it is wastage, never stock) and a place no longer in use (422 `unknown_location`). Emits `pharmacy.sale_returned`. The Idempotency-Key header is required: a repeat moves no stock and answers with the sale as it is now. Requires sale:return and sale:read with the scope `all` and the pharmacy feature flag. Audited.',
        headers: RequiredIdempotencyHeaders,
        params: SaleParams,
        body: ref(SaleReturnCreate),
        response: { 201: ref(PharmacySale), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (!reaches(request, SALE_RETURN) || !reaches(request, SALE_READ)) throw saleNotFound();
      if (request.replayOf !== null) {
        const saleId = request.idempotentId
          ? await saleOfReturn(request.txClient, request.idempotentId)
          : null;
        return replaySale(request, reply, saleId);
      }
      const body = request.body as SaleReturnCreate;
      const client = request.txClient;
      const actorId = userIdOf(request);
      const saleId = request.params.saleId.toLowerCase();
      if (!isUuid(saleId)) throw saleNotFound();
      const reason = tidyWithin(body.reason, REASON_MAX);
      // Held against another return of the sale, so two together never return a unit twice.
      await lockSale(client, saleId);
      const sale = await findSale(client, saleId);
      if (!sale) throw saleNotFound();
      const wanted = body.lines.map((line) => line.saleLineId.toLowerCase());
      if (new Set(wanted).size !== wanted.length) {
        throw new HttpError(422, 'unknown_line', 'A line is given once in a return');
      }
      const byDrug = new Map<
        string,
        { saleLineId: string; batchId: string; quantity: number; price: bigint }[]
      >();
      let total = 0n;
      for (const line of body.lines) {
        const sold = sale.lines.find((each) => each.id === line.saleLineId.toLowerCase());
        if (!sold) throw new HttpError(422, 'unknown_line', 'No such line of the sale');
        if (line.quantity > sold.quantity - sold.returnedQuantity) {
          throw new HttpError(409, 'over_return', 'More than was sold and not yet returned');
        }
        const price = BigInt(sold.unitPriceMinor);
        total += price * BigInt(line.quantity);
        const group = byDrug.get(sold.drugId) ?? [];
        group.push({ saleLineId: sold.id, batchId: sold.batchId, quantity: line.quantity, price });
        byDrug.set(sold.drugId, group);
      }
      const returnId = randomUUID();
      const posted: Parameters<typeof insertSaleReturnLine>[1][] = [];
      for (const drugId of [...byDrug.keys()].sort()) {
        const group = byDrug.get(drugId) ?? [];
        const entries = await stockIn(request, {
          locationId: sale.location_id,
          drugId,
          source: 'sale_return',
          sourceId: returnId,
          reason: 'sale_return',
          actorId,
          lines: group.map((each) => ({ batchId: each.batchId, quantity: each.quantity })),
        });
        for (const [index, entry] of entries.entries()) {
          const line = group[index];
          if (!line) continue;
          posted.push({
            returnId,
            saleId,
            saleLineId: line.saleLineId,
            batchId: entry.batchId,
            quantity: entry.quantity,
            ledgerEntryId: entry.ledgerEntryId,
          });
        }
      }
      await insertSaleReturn(client, {
        id: returnId,
        saleId,
        reason,
        totalMinor: total,
        returnedBy: actorId,
      });
      for (const line of posted) await insertSaleReturnLine(client, line);
      request.idempotentId = returnId;
      request.audit('create', 'pharmacy_sale_return', returnId);
      await request.emit('pharmacy.sale_returned', returnId, { saleId, returnId });
      return reply.status(201).send(await saleAnswer(request, saleId));
    },
  );

  app.post(
    '/pharmacy/sales/:saleId/print',
    {
      config: {
        permissions: [SALE_READ],
        feature: FEATURE,
        idempotent: { body: 'none', required: true },
      },
      schema: {
        operationId: 'printSaleReceipt',
        tags: ['pharmacy'],
        description:
          'Records that a sale’s receipt is printed (the audit entry `print` of the sale) and answers 204: the web app makes the page from what it read. A new key per press; a repeat records nothing more. Requires sale:read with the scope `all` and the pharmacy feature flag.',
        headers: RequiredIdempotencyHeaders,
        params: SaleParams,
        response: { 204: Type.Null(), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request, reply) => {
      if (!reaches(request, SALE_READ)) throw saleNotFound();
      const sale = await findSale(request.txClient, request.params.saleId);
      if (!sale) throw saleNotFound();
      if (request.replayOf === null) request.audit('print', 'pharmacy_sale', sale.id);
      return reply.status(204).send(null);
    },
  );

  app.get(
    '/pharmacy/register',
    {
      config: { permissions: [REGISTER_READ], feature: FEATURE },
      schema: {
        operationId: 'listDrugRegister',
        tags: ['pharmacy'],
        description:
          'The drug register of an item of schedule H1, X, narcotic or controlled (422 `not_a_register_item` for another, 404 `item_not_found` for none): every movement of its stock from the ledger, from the first day to the last at the hospital (at most 366 days), the oldest first: dispenses, counter sales, their returns (a dispense’s wasted units in and out again, reason `wastage`) and adjustments, each with its batch, place, quantity, the batch’s balance after it, who made it, and for a dispense or sale who it was for and who prescribed it. Read from the ledger, so no movement can be left out. `total` with the first page. Every dispense and sale named is audited as read. Requires drugRegister:read with the scope `all` and the pharmacy feature flag. The item is an id: a GET.',
        querystring: RegisterQuery,
        response: { 200: ref(RegisterPage), ...errors(400, 401, 403, 404, 409, 422, 429) },
      },
    },
    async (request) => {
      const query = request.query as RegisterQuery;
      if (!reaches(request, REGISTER_READ)) return { items: [], nextCursor: null, total: 0 };
      const span = daysBetween(query.from, query.to);
      if (
        !isCalendarDate(query.from) ||
        !isCalendarDate(query.to) ||
        span < 0 ||
        span >= REGISTER_DAYS_MAX
      ) {
        throw new HttpError(
          400,
          'validation_failed',
          `From a day to one no earlier, within ${REGISTER_DAYS_MAX} days`,
        );
      }
      // An archived item keeps its register: looked up whatever its state.
      const item = await registerDrug(request.txClient, query.drugId);
      if (!item) throw new HttpError(404, 'item_not_found', 'No such item');
      if (!inRegister(item)) {
        throw new HttpError(422, 'not_a_register_item', 'The item is not kept in the register');
      }
      const page = await listRegister(request.txClient, {
        drugId: item.id,
        from: query.from,
        to: query.to,
        ...optional('cursor', query.cursor),
        limit: query.limit ?? DEFAULT_PAGE_SIZE,
      });
      if (!page) throw new HttpError(400, 'invalid_cursor', 'Unknown cursor');
      for (const row of page.rows) {
        if (row.dispense_id) request.audit('read', 'dispense', row.dispense_id);
        else if (row.sale_id && row.patient_id) request.audit('read', 'pharmacy_sale', row.sale_id);
      }
      return {
        items: page.rows.map(registerView),
        nextCursor: page.nextCursor,
        ...optional('total', page.total),
      };
    },
  );
};
