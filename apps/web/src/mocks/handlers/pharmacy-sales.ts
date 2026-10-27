import type { components } from '@mediflow/contract';
import { http, HttpResponse } from 'msw';
import { todayIn, zonedToUtc } from '@/shared/utils/timezone';
import { currentPolicy, currentSession, mockTenantTimezone, onMockReset } from '../db';
import { authorize, error } from '../respond';
import { mockMedicationPrescriptions } from './clinical';
import { mockDrug } from './drugs';
import { mockLedgerOf, mockStockIn, mockStockOut, mockUsableBatches } from './inventory';
import { mockPatient } from './patients';
import { mockDispenses } from './pharmacy';

type Drug = components['schemas']['Drug'];
type PharmacySale = components['schemas']['PharmacySale'];
type SaleListItem = components['schemas']['SaleListItem'];
type DrugRegisterEntry = components['schemas']['DrugRegisterEntry'];

const FEATURE_FLAG = 'pharmacy';
const DAY_MS = 86_400_000;
const PRESCRIPTION_SCHEDULES = ['h', 'h1', 'x', 'narcotic'];
const REGISTER_SCHEDULES = ['h1', 'x', 'narcotic'];
const ITEMS_MAX = 20;
const QUANTITY_MAX = 10_000;

const needsPrescription = (drug: Drug) =>
  drug.controlled || PRESCRIPTION_SCHEDULES.includes(drug.schedule);
const inRegister = (drug: Drug) => drug.controlled || REGISTER_SCHEDULES.includes(drug.schedule);

/**
 * Counter sales, their returns and the drug register (#101), as the API: stock out and back
 * through the inventory mock (`mockStockOut`, `mockStockIn`), each batch at its price, scheduled
 * items only against an outside prescription to a patient, and the register read from the
 * inventory mock's ledger. Nothing sold at first.
 */
function seed() {
  return {
    sales: [] as (PharmacySale & { tenantId: string })[],
    prints: [] as { tenantId: string; saleId: string }[],
    answered: new Map<string, { body: string; saleId: string }>(),
    counter: 0,
  };
}

let state = seed();
onMockReset(() => {
  state = seed();
});

/** For tests: the sales and printed receipts as the mock holds them. */
export const mockSales = () => ({ sales: state.sales, prints: state.prints });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const callerOf = () => currentSession()?.user ?? { id: '', name: '' };
const invalid = (message = 'The request is not valid') => error(400, 'validation_failed', message);
const saleNotFound = () => error(404, 'sale_not_found', 'No such sale');
const holds = (permission: string) =>
  currentPolicy()?.permissions.some((grant) => grant.permission === permission) ?? false;

/** Every permission named, with the pharmacy switch on. */
function authorizeAll(request: Request, permissions: string[]) {
  let last: ReturnType<typeof authorize> | undefined;
  for (const permission of permissions) {
    last = authorize(request, { permission, featureFlag: FEATURE_FLAG });
    if ('denied' in last) return last;
  }
  return last as { tenantId: string };
}

const nameOf = (drug: Drug) =>
  `${drug.genericName}${drug.strength ? ` ${drug.strength}` : ''}${drug.brandName ? ` (${drug.brandName})` : ''}`;

const saleOf = (tenantId: string, id: string) =>
  state.sales.find((each) => each.id === id && each.tenantId === tenantId);

const view = ({ tenantId: _tenant, ...sale }: PharmacySale & { tenantId: string }): PharmacySale =>
  sale;

/** A repeat of a key with the same body: the sale as it is now. */
async function keyed(request: Request, tenantId: string) {
  const key = request.headers.get('Idempotency-Key');
  if (!key) return { refused: error(400, 'validation_failed', 'An Idempotency-Key is required') };
  const text = await request.text();
  const body: unknown = text ? JSON.parse(text) : null;
  const keyOf = `${tenantId}:${callerOf().id}:${new URL(request.url).pathname}:${key}`;
  const earlier = state.answered.get(keyOf);
  if (earlier && earlier.body !== JSON.stringify(body)) {
    return {
      refused: error(422, 'idempotency_key_reuse', 'This key was used for a different request'),
    };
  }
  return {
    body,
    earlier: earlier ? saleOf(tenantId, earlier.saleId) : undefined,
    remember: (saleId: string) => state.answered.set(keyOf, { body: JSON.stringify(body), saleId }),
  };
}

const returnedOf = (sale: PharmacySale) =>
  sale.returns.reduce((sum, each) => sum + Number(each.totalMinor), 0);

export const pharmacySaleHandlers = [
  http.get('/api/pharmacy/sale-options', ({ request }) => {
    const access = authorizeAll(request, ['sale:create']);
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const drug = mockDrug(access.tenantId, url.searchParams.get('drugId') ?? '');
    if (!drug || drug.archived) return error(404, 'item_not_found', 'No such item');
    const batches = mockUsableBatches(
      access.tenantId,
      [drug.id],
      url.searchParams.get('locationId') ?? '',
    );
    return HttpResponse.json({
      drugId: drug.id,
      name: nameOf(drug),
      schedule: drug.schedule,
      controlled: drug.controlled,
      needsPrescription: needsPrescription(drug),
      inRegister: inRegister(drug),
      batches: batches.map(({ drugId: _drug, mrpMinor, ...batch }) => ({
        ...batch,
        ...(mrpMinor === undefined ? {} : { mrpMinor: String(mrpMinor) }),
      })),
    });
  }),

  http.post('/api/pharmacy/sales', async ({ request }) => {
    const access = authorizeAll(request, ['sale:read', 'sale:create']);
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sent = await keyed(request, tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.earlier) return HttpResponse.json(view(sent.earlier), { status: 201 });
    const body = sent.body;
    if (!isObject(body) || typeof body.locationId !== 'string' || !Array.isArray(body.lines)) {
      return invalid();
    }
    const lines = body.lines as unknown[];
    if (lines.length === 0 || lines.length > ITEMS_MAX) return invalid();
    const patientId = typeof body.patientId === 'string' ? body.patientId : null;
    const prescription = [body.prescriberName, body.prescriberRegistration, body.prescribedOn];
    const given = prescription.filter((each) => typeof each === 'string' && each !== '').length;
    if (given !== 0 && given !== 3) return invalid('A prescription is recorded whole');
    if (given === 3 && String(body.prescribedOn) > todayIn(mockTenantTimezone(tenantId))) {
      return invalid('A prescription is not dated ahead');
    }
    const patient = patientId ? mockPatient(tenantId, patientId) : undefined;
    if (patientId && (!patient || !holds('patient:read'))) {
      return error(422, 'unknown_patient', 'No such patient');
    }
    if (given === 3 && !patient) {
      return error(422, 'prescription_required', 'A prescription is of a patient');
    }
    const items: { drug: Drug; batches: { batchId: string; quantity: number }[] }[] = [];
    for (const line of lines) {
      if (!isObject(line) || typeof line.drugId !== 'string' || !Array.isArray(line.batches)) {
        return invalid();
      }
      const drug = mockDrug(tenantId, line.drugId);
      if (!drug || drug.archived || items.some((each) => each.drug.id === drug.id)) {
        return error(422, 'unknown_item', 'No such item in use');
      }
      if (needsPrescription(drug) && (!patient || given !== 3)) {
        return error(422, 'prescription_required', 'Sold against a prescription to a patient');
      }
      const batches = (line.batches as unknown[]).map((each) =>
        isObject(each) ? { batchId: String(each.batchId), quantity: Number(each.quantity) } : null,
      );
      if (
        batches.some((each) => !each || !Number.isInteger(each.quantity) || each.quantity < 1) ||
        batches.reduce((sum, each) => sum + (each?.quantity ?? 0), 0) > QUANTITY_MAX
      ) {
        return invalid();
      }
      items.push({ drug, batches: batches as { batchId: string; quantity: number }[] });
    }
    // Checked before anything moves, so a refusal moves nothing, as the API's transaction.
    for (const item of items) {
      const usable = mockUsableBatches(tenantId, [item.drug.id], body.locationId);
      for (const line of item.batches) {
        const batch = usable.find((each) => each.batchId === line.batchId);
        // Unknown, of another item, expired or with no stock here: what `mockStockOut` says.
        if (!batch) {
          const refused = mockStockOut(tenantId, {
            locationId: String(body.locationId),
            drugId: item.drug.id,
            sourceId: 'check',
            actorName: '',
            source: 'sale',
            lines: [{ batchId: line.batchId, quantity: Number.MAX_SAFE_INTEGER }],
          });
          const code = 'refused' in refused ? refused.refused : 'insufficient_stock';
          const status = code === 'unknown_location' || code === 'unknown_batch' ? 422 : 409;
          return error(status, code, 'Refused');
        }
        if (batch.mrpMinor === undefined) {
          return error(409, 'no_price', 'The batch has no price to sell at');
        }
        if (batch && batch.onHand < line.quantity) {
          return error(409, 'insufficient_stock', 'The batch has fewer units than that');
        }
      }
    }
    state.counter += 1;
    const saleId = `sal_${state.counter}`;
    const caller = callerOf();
    const sold: PharmacySale['lines'] = [];
    let locationName = '';
    for (const item of items) {
      const usable = mockUsableBatches(tenantId, [item.drug.id], body.locationId);
      const out = mockStockOut(tenantId, {
        locationId: body.locationId,
        drugId: item.drug.id,
        sourceId: saleId,
        actorName: caller.name,
        source: 'sale',
        lines: item.batches,
      });
      if ('refused' in out) {
        const status =
          out.refused === 'unknown_location' || out.refused === 'unknown_batch' ? 422 : 409;
        return error(status, out.refused, 'Refused');
      }
      locationName = out.locationName;
      for (const batch of out.batches) {
        sold.push({
          id: `sli_${state.counter}_${sold.length + 1}`,
          lineNumber: sold.length + 1,
          drugId: item.drug.id,
          itemName: nameOf(item.drug),
          schedule: item.drug.schedule,
          controlled: item.drug.controlled,
          batchId: batch.batchId,
          batchNumber: batch.batchNumber,
          expiryDate: batch.expiryDate,
          quantity: batch.quantity,
          returnedQuantity: 0,
          unitPriceMinor: String(
            usable.find((each) => each.batchId === batch.batchId)?.mrpMinor ?? 0,
          ),
        });
      }
    }
    const sale: PharmacySale & { tenantId: string } = {
      tenantId,
      id: saleId,
      locationId: body.locationId,
      locationName,
      ...(patient && patientId
        ? { patientId, patientName: patient.name, patientMrn: patient.mrn }
        : {}),
      ...(given === 3
        ? {
            prescriberName: String(body.prescriberName).trim(),
            prescriberRegistration: String(body.prescriberRegistration).trim(),
            prescribedOn: String(body.prescribedOn),
          }
        : {}),
      totalMinor: String(
        sold.reduce((sum, line) => sum + Number(line.unitPriceMinor) * line.quantity, 0),
      ),
      returnedMinor: '0',
      soldAt: new Date().toISOString(),
      soldByName: caller.name,
      lines: sold,
      returns: [],
    };
    state.sales.push(sale);
    sent.remember(saleId);
    return HttpResponse.json(view(sale), { status: 201 });
  }),

  http.get('/api/pharmacy/sales', ({ request }) => {
    const access = authorizeAll(request, ['sale:read']);
    if ('denied' in access) return access.denied;
    const url = new URL(request.url);
    const days = Number(url.searchParams.get('days') ?? 7);
    if (!Number.isInteger(days) || days < 1 || days > 90) return invalid();
    const limit = Number(url.searchParams.get('limit') ?? 25);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const timezone = mockTenantTimezone(access.tenantId);
    const start = zonedToUtc(
      new Date(Date.parse(`${todayIn(timezone)}T00:00:00Z`) - (days - 1) * DAY_MS)
        .toISOString()
        .slice(0, 10),
      '00:00',
      timezone,
    );
    const all = state.sales
      .filter((each) => each.tenantId === access.tenantId && each.soldAt >= start)
      .sort((a, b) => b.soldAt.localeCompare(a.soldAt) || b.id.localeCompare(a.id));
    const items: SaleListItem[] = all.slice(offset, offset + limit).map((sale) => ({
      id: sale.id,
      soldAt: sale.soldAt,
      soldByName: sale.soldByName,
      locationName: sale.locationName,
      ...(sale.patientId
        ? { patientId: sale.patientId, patientName: sale.patientName, patientMrn: sale.patientMrn }
        : {}),
      lineCount: sale.lines.length,
      totalMinor: sale.totalMinor,
      returnedMinor: sale.returnedMinor,
    }));
    return HttpResponse.json({
      items,
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      ...(offset === 0 ? { total: all.length } : {}),
    });
  }),

  http.get('/api/pharmacy/sales/:saleId', ({ request, params }) => {
    const access = authorizeAll(request, ['sale:read']);
    if ('denied' in access) return access.denied;
    const sale = saleOf(access.tenantId, String(params.saleId));
    return sale ? HttpResponse.json(view(sale)) : saleNotFound();
  }),

  http.post('/api/pharmacy/sales/:saleId/returns', async ({ request, params }) => {
    const access = authorizeAll(request, ['sale:read', 'sale:return']);
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const sale = saleOf(tenantId, String(params.saleId));
    if (!sale) return saleNotFound();
    const sent = await keyed(request, tenantId);
    if ('refused' in sent) return sent.refused;
    if (sent.earlier) return HttpResponse.json(view(sent.earlier), { status: 201 });
    const body = sent.body;
    if (!isObject(body) || typeof body.reason !== 'string' || !Array.isArray(body.lines)) {
      return invalid();
    }
    const reason = body.reason.trim();
    if (reason === '' || reason.length > 200) return invalid();
    const wanted: { line: PharmacySale['lines'][number]; quantity: number }[] = [];
    for (const each of body.lines as unknown[]) {
      if (!isObject(each)) return invalid();
      const line = sale.lines.find((one) => one.id === each.saleLineId);
      if (!line || wanted.some((one) => one.line.id === line.id)) {
        return error(422, 'unknown_line', 'No such line of the sale');
      }
      const quantity = Number(each.quantity);
      if (!Number.isInteger(quantity) || quantity < 1) return invalid();
      if (quantity > line.quantity - line.returnedQuantity) {
        return error(409, 'over_return', 'More than was sold and not yet returned');
      }
      wanted.push({ line, quantity });
    }
    state.counter += 1;
    const returnId = `srt_${state.counter}`;
    const caller = callerOf();
    const refused = mockStockIn(tenantId, {
      locationId: sale.locationId,
      sourceId: returnId,
      actorName: caller.name,
      lines: wanted.map((each) => ({ batchId: each.line.batchId, quantity: each.quantity })),
    });
    if (refused) {
      return error(refused.refused === 'batch_expired' ? 409 : 422, refused.refused, 'Refused');
    }
    for (const each of wanted) each.line.returnedQuantity += each.quantity;
    sale.returns.push({
      id: returnId,
      reason,
      totalMinor: String(
        wanted.reduce((sum, each) => sum + Number(each.line.unitPriceMinor) * each.quantity, 0),
      ),
      returnedAt: new Date().toISOString(),
      returnedByName: caller.name,
      lines: wanted.map((each) => ({ saleLineId: each.line.id, quantity: each.quantity })),
    });
    sale.returnedMinor = String(returnedOf(sale));
    sent.remember(sale.id);
    return HttpResponse.json(view(sale), { status: 201 });
  }),

  http.post('/api/pharmacy/sales/:saleId/print', ({ request, params }) => {
    const access = authorizeAll(request, ['sale:read']);
    if ('denied' in access) return access.denied;
    const sale = saleOf(access.tenantId, String(params.saleId));
    if (!sale) return saleNotFound();
    state.prints.push({ tenantId: access.tenantId, saleId: sale.id });
    return new HttpResponse(null, { status: 204 });
  }),

  http.get('/api/pharmacy/register', ({ request }) => {
    const access = authorizeAll(request, ['drugRegister:read']);
    if ('denied' in access) return access.denied;
    const { tenantId } = access;
    const url = new URL(request.url);
    const from = url.searchParams.get('from') ?? '';
    const to = url.searchParams.get('to') ?? '';
    const span = (Date.parse(to) - Date.parse(from)) / DAY_MS;
    if (Number.isNaN(span) || span < 0 || span >= 366) return invalid();
    const drug = mockDrug(tenantId, url.searchParams.get('drugId') ?? '');
    if (!drug) return error(404, 'item_not_found', 'No such item');
    if (!inRegister(drug)) {
      return error(422, 'not_a_register_item', 'The item is not kept in the register');
    }
    const timezone = mockTenantTimezone(tenantId);
    const start = zonedToUtc(from, '00:00', timezone);
    const end = zonedToUtc(
      new Date(Date.parse(`${to}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10),
      '00:00',
      timezone,
    );
    const { dispenses } = mockDispenses();
    const all = mockLedgerOf(tenantId, drug.id).filter(
      (entry) => entry.at >= start && entry.at < end,
    );
    const limit = Number(url.searchParams.get('limit') ?? 50);
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const items: DrugRegisterEntry[] = all.slice(offset, offset + limit).map((entry) => {
      const sale =
        entry.source === 'sale'
          ? saleOf(tenantId, entry.sourceId)
          : entry.source === 'sale_return'
            ? state.sales.find(
                (each) =>
                  each.tenantId === tenantId &&
                  each.returns.some((back) => back.id === entry.sourceId),
              )
            : undefined;
      const dispense =
        entry.source === 'dispense'
          ? dispenses.find((each) => each.id === entry.sourceId)
          : undefined;
      const patientId = dispense?.patientId ?? sale?.patientId;
      const patient = patientId ? mockPatient(tenantId, patientId) : undefined;
      const rx = dispense
        ? mockMedicationPrescriptions(tenantId).find((each) => each.id === dispense.prescriptionId)
        : undefined;
      const prescriber = rx?.prescribedByName ?? sale?.prescriberName;
      return {
        id: entry.id,
        at: entry.at,
        locationName: entry.locationName,
        batchNumber: entry.batchNumber,
        expiryDate: entry.expiryDate,
        quantity: entry.quantity,
        balanceAfter: entry.balanceAfter,
        source: entry.source,
        sourceId: entry.sourceId,
        reason: entry.reason,
        actorName: entry.actorName,
        ...(patient && patientId
          ? { patientId, patientName: patient.name, patientMrn: patient.mrn }
          : {}),
        ...(dispense ? { prescriptionId: dispense.prescriptionId } : {}),
        ...(prescriber ? { prescriberName: prescriber } : {}),
        ...(sale?.prescriberRegistration
          ? { prescriberRegistration: sale.prescriberRegistration }
          : {}),
      };
    });
    return HttpResponse.json({
      items,
      nextCursor: offset + limit < all.length ? String(offset + limit) : null,
      ...(offset === 0 ? { total: all.length } : {}),
    });
  }),
];
