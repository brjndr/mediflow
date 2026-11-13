import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import type { TaxClass } from './tax.js';

/**
 * Posts charges from what the other modules emit (#114). A module never writes a charge or an
 * invoice; billing listens. Every handler is idempotent: a charge is unique by what caused it
 * (`source_ref`), so an event delivered twice, or an order completed again after a reopening,
 * posts nothing more. The service's price is the one in effect today on the hospital's standard
 * price list. A service archived since, or with no price in effect, is posted at its last price
 * and flagged for the billing desk; with no price at all it is posted at nothing and flagged:
 * work already done is never held up by the price list.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string | null =>
  typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null;

export interface Posting {
  encounterId: string;
  patientId: string;
  serviceId: string | null;
  source: 'order' | 'procedure' | 'dispense' | 'service' | 'package' | 'bed';
  /** Who asked for it, when a person did; null for a charge posted from an event. */
  actorId?: string;
  sourceRef: string;
  description: string;
  quantity: number;
  /** Ignored when the price comes from the service's price list. */
  unitPriceMinor: number;
  flag: 'no_price' | null;
  /** A calendar date (hospital clock) to price the service on, instead of today; bed days use it. */
  priceDate?: string;
}

export interface ServicePrice {
  name: string;
  archived: boolean;
  /** The tax class the service has now; a charge keeps the one it was posted with. */
  taxClass: TaxClass;
  /** The standard price list's price in effect today; null when none is in effect. */
  amountMinor: number | null;
}

/**
 * A service and its price on a date (today unless given) on the hospital's standard price list;
 * null if no such service.
 */
export async function priceOf(
  tx: Database,
  serviceId: string,
  onDate: string | null = null,
): Promise<ServicePrice | null> {
  const { rows } = await tx.execute<{
    name: string;
    archived: boolean;
    tax_class: TaxClass;
    amount: string | null;
  }>(
    sql`select s.name, s.archived, s.tax_class,
          (select sp.amount_minor::text from service_prices sp
            join price_lists pl on pl.tenant_id = sp.tenant_id and pl.id = sp.price_list_id
              and pl.standard
            where sp.service_id = s.id and sp.withdrawn_at is null
              and sp.effective_from <= d.today
            order by (sp.effective_to is null or sp.effective_to >= d.today) desc,
              sp.effective_from desc
            limit 1) as amount
        from services s,
          (select coalesce(${onDate}::date, (now() at time zone timezone)::date) as today
           from tenants where id = app_tenant_id()) d
        where s.id = ${serviceId}`,
  );
  const service = rows[0];
  if (!service) return null;
  return {
    name: service.name,
    archived: service.archived,
    taxClass: service.tax_class,
    amountMinor: service.amount === null ? null : Number(service.amount),
  };
}

/**
 * The package charge of this visit that includes the service (and does not exclude it), when
 * there is one that is not void: its work is part of the package price.
 */
export async function coveringPackage(
  tx: Database,
  encounterId: string,
  serviceId: string,
): Promise<string | null> {
  const { rows } = await tx.execute<{ id: string }>(
    sql`select c.id from charges c
        join package_items i on i.tenant_id = c.tenant_id and i.package_service_id = c.service_id
        where c.encounter_id = ${encounterId} and c.source = 'package' and c.status <> 'void'
          and i.service_id = ${serviceId} and i.kind = 'included'
        order by c.posted_at, c.id
        limit 1`,
  );
  return rows[0]?.id ?? null;
}

/**
 * Posts one charge unless one was posted for the same cause; emits `charge.posted`. Answers the
 * charge's id, or null when nothing was posted.
 */
export async function postCharge(tx: Database, posting: Posting): Promise<string | null> {
  let unit = posting.unitPriceMinor;
  let flag: string | null = posting.flag;
  let description = posting.description;
  // A dispensed medicine is charged at its MRP, which holds the tax already: no class.
  let taxClass: TaxClass | null = null;
  if (posting.serviceId !== null) {
    const service = await priceOf(tx, posting.serviceId, posting.priceDate ?? null);
    if (!service) return null;
    description = service.name;
    taxClass = service.taxClass;
    unit = service.amountMinor ?? 0;
    flag = service.amountMinor === null ? 'no_price' : service.archived ? 'service_archived' : null;
  }
  // Work for a service a package on this visit already includes is not billed again: it is
  // posted void, pointing at the package charge, so the ledger keeps it.
  let status = 'pending';
  let coveredBy: string | null = null;
  if (posting.serviceId !== null && posting.source !== 'package') {
    // Serialises with a package being applied to the visit (which locks it for update), so one
    // of the two always sees the other and the work is never billed on top of the package.
    await tx.execute(sql`select id from encounters where id = ${posting.encounterId} for share`);
    coveredBy = await coveringPackage(tx, posting.encounterId, posting.serviceId);
    if (coveredBy) {
      status = 'void';
      flag = 'package_covered';
    }
  }
  const { rows } = await tx.execute<{ id: string }>(
    sql`insert into charges (tenant_id, encounter_id, patient_id, service_id, source, source_ref,
          description, quantity, unit_price_minor, flag, tax_class, status, package_charge_id)
        values (app_tenant_id(), ${posting.encounterId}, ${posting.patientId},
          ${posting.serviceId}, ${posting.source}, ${posting.sourceRef},
          left(${description}, 200), ${posting.quantity}, ${unit}, ${flag}, ${taxClass},
          ${status}, ${coveredBy})
        on conflict (tenant_id, source_ref) do nothing
        returning id`,
  );
  const id = rows[0]?.id;
  if (!id) return null;
  const payload = JSON.stringify({
    chargeId: id,
    encounterId: posting.encounterId,
    patientId: posting.patientId,
  });
  await tx.execute(
    sql`insert into outbox (tenant_id, event, entity_id, actor_id, payload)
        values (app_tenant_id(), 'charge.posted', ${id}, ${posting.actorId ?? null}, ${payload})`,
  );
  return id;
}

export function subscribeToPostings(app: FastifyInstance): void {
  // A lab, imaging or procedure order done is charged as its service. Medication orders are
  // charged when dispensed, and diet orders have no price here yet.
  app.events.subscribe('order.completed', async (message, tx) => {
    const { payload } = message;
    const orderId = idOf(message.entityId);
    const encounterId = idOf(payload.encounterId);
    const patientId = idOf(payload.patientId);
    if (!orderId || !encounterId || !patientId) return;
    let serviceId: string | null = null;
    if (payload.type === 'lab') {
      const labTestId = idOf(payload.labTestId);
      if (!labTestId) return;
      const { rows } = await tx.execute<{ service_id: string | null }>(
        sql`select service_id from lab_tests where id = ${labTestId}`,
      );
      serviceId = rows[0]?.service_id ?? null;
    } else if (payload.type === 'imaging' || payload.type === 'procedure') {
      serviceId = idOf(payload.serviceId);
    }
    // A test with no service to charge it as has nothing to post.
    if (!serviceId) return;
    await postCharge(tx, {
      encounterId,
      patientId,
      serviceId,
      source: payload.type === 'procedure' ? 'procedure' : 'order',
      sourceRef: `order:${orderId}`,
      description: '',
      quantity: 1,
      unitPriceMinor: 0,
      flag: null,
    });
  });

  // A dispense is charged for each batch it took from, at that batch's price.
  app.events.subscribe('pharmacy.dispensed', async (message, tx) => {
    const dispenseId = idOf(message.entityId);
    if (!dispenseId) return;
    const { rows } = await tx.execute<{
      id: string;
      quantity: number;
      item_name: string;
      encounter_id: string;
      patient_id: string;
      mrp_minor: string | null;
    }>(
      sql`select dl.id, dl.quantity, d.item_name, d.encounter_id, d.patient_id,
            b.mrp_minor::text as mrp_minor
          from dispense_lines dl
          join dispenses d on d.tenant_id = dl.tenant_id and d.id = dl.dispense_id
          join stock_batches b on b.tenant_id = dl.tenant_id and b.id = dl.batch_id
          where dl.dispense_id = ${dispenseId}
          order by dl.id`,
    );
    for (const line of rows) {
      await postCharge(tx, {
        encounterId: line.encounter_id,
        patientId: line.patient_id,
        serviceId: null,
        source: 'dispense',
        sourceRef: `dispense:${line.id}`,
        description: line.item_name,
        quantity: line.quantity,
        unitPriceMinor: line.mrp_minor === null ? 0 : Number(line.mrp_minor),
        flag: line.mrp_minor === null ? 'no_price' : null,
      });
    }
  });

  // Units brought back after the charge: one still pending and on no draft, wholly returned, is
  // voided; any other is flagged, for the billing desk to credit. Computed from what has been
  // returned in all, so a repeat changes nothing.
  app.events.subscribe('pharmacy.dispense_returned', async (message, tx) => {
    const dispenseId = idOf(message.payload.dispenseId);
    if (!dispenseId) return;
    await tx.execute(
      sql`update charges c set flag = 'return_review',
            status = case when c.status = 'pending' and c.invoice_id is null
              and r.returned >= c.quantity then 'void' else c.status end
          from (select dl.id as line_id, coalesce((select sum(rl.quantity)
                  from dispense_return_lines rl
                  where rl.dispense_id = dl.dispense_id and rl.batch_id = dl.batch_id), 0)
                  as returned
                from dispense_lines dl where dl.dispense_id = ${dispenseId}) r
          where c.source_ref = 'dispense:' || r.line_id and r.returned > 0
            and c.status <> 'void'`,
    );
  });
}
