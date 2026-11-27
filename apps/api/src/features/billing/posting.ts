import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Database } from '../../core/db/client.js';
import { billedByALine } from './repository.js';
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

/**
 * The charge `c` is named by a line of an invoice not void (#1255): one such is never voided or
 * taken as free by an event, even pending and held by no invoice.
 */
const BILLED = sql.raw(billedByALine('c'));

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
 * The visit a surgery is charged to now and the day it was completed (hospital clock), held until
 * the charges are posted: an event that carries an earlier link and is handled after a relink
 * charges the booking's visit (#1233). The link route locks the booking for update, so one of the
 * two always sees the other.
 */
async function bookingOf(
  tx: Database,
  surgeryId: string,
): Promise<{ visitId: string | null; doneOn: string | null }> {
  const { rows } = await tx.execute<{ encounter_id: string | null; done_on: string | null }>(
    sql`select b.encounter_id, (b.completed_at at time zone t.timezone)::date::text as done_on
        from ot_bookings b join tenants t on t.id = b.tenant_id
        where b.id = ${surgeryId} for share of b`,
  );
  return { visitId: rows[0]?.encounter_id ?? null, doneOn: rows[0]?.done_on ?? null };
}

/**
 * Moves the procedure charge of a completed surgery off the cancelled visit it was linked to
 * (#1233). A charge never changes its visit: one still pending and on no invoice is voided, one
 * on an invoice or a draft is flagged `relink_review`, and one posted void stays. The new visit
 * is charged at the price of the day the surgery was completed. Work a package of the old visit
 * included is charged again too, and a package charge that is on a bill is flagged for the desk.
 */
async function moveProcedureCharge(
  tx: Database,
  move: {
    surgeryId: string;
    from: string;
    to: string;
    patientId: string;
    eventId: string;
    doneOn: string | null;
  },
): Promise<void> {
  const base = `surgery:${move.surgeryId}`;
  const { rows } = await tx.execute<{
    id: string;
    service_id: string;
    package_charge_id: string | null;
    movable: boolean;
    dropped: boolean;
  }>(
    sql`select c.id, c.service_id, c.package_charge_id,
          (c.status = 'pending' and c.invoice_id is null and not ${BILLED}) as movable,
          (c.status = 'void') as dropped
        from charges c
        where (c.source_ref = ${base} or c.source_ref like ${`${base}:%`})
          and c.encounter_id = ${move.from}
          and (c.status <> 'void' or c.flag in ('visit_cancelled', 'package_covered'))
          and c.flag is distinct from 'relink_review'
        for update`,
  );
  for (const charge of rows) {
    if (!charge.dropped) {
      await tx.execute(
        charge.movable
          ? sql`update charges set status = 'void' where id = ${charge.id}`
          : sql`update charges set flag = 'relink_review' where id = ${charge.id}`,
      );
    } else if (charge.package_charge_id) {
      await tx.execute(
        sql`update charges c set flag = 'relink_review' where c.id = ${charge.package_charge_id}
              and c.status <> 'void'
              and not (c.status = 'pending' and c.invoice_id is null and not ${BILLED})`,
      );
    }
    await postCharge(tx, {
      encounterId: move.to,
      patientId: move.patientId,
      serviceId: charge.service_id,
      source: 'procedure',
      sourceRef: `${base}:${move.eventId}`,
      description: '',
      quantity: 1,
      unitPriceMinor: 0,
      flag: null,
      ...(move.doneOn ? { priceDate: move.doneOn } : {}),
    });
  }
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
  let status = 'pending';
  let coveredBy: string | null = null;
  // Serialises with the visit being cancelled and with a package being applied to it (both lock
  // it for update), so one of the two always sees the other.
  const { rows: visit } = await tx.execute<{ status: string }>(
    sql`select status from encounters where id = ${posting.encounterId} for share`,
  );
  // A cancelled visit is never billed (#1222): work reported for one is kept, void.
  if (visit[0]?.status === 'cancelled') {
    status = 'void';
    flag = 'visit_cancelled';
  } else if (posting.serviceId !== null && posting.source !== 'package') {
    // Work for a service a package on this visit already includes is not billed again: it is
    // posted void, pointing at the package charge, so the ledger keeps it.
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

  // A trip completed with a visit and a service is charged as that service (#589). The
  // ambulance module only says what happened; the price is the list's, never the trip's.
  app.events.subscribe('ambulance.trip_status_changed', async (message, tx) => {
    const { payload } = message;
    if (payload.to !== 'completed') return;
    const tripId = idOf(message.entityId);
    const encounterId = idOf(payload.encounterId);
    const patientId = idOf(payload.patientId);
    const serviceId = idOf(payload.serviceId);
    if (!tripId || !encounterId || !patientId || !serviceId) return;
    await postCharge(tx, {
      encounterId,
      patientId,
      serviceId,
      source: 'service',
      sourceRef: `ambulance:${tripId}`,
      description: '',
      quantity: 1,
      unitPriceMinor: 0,
      flag: null,
    });
  });

  // A fulfilled request for a copy of a record that named a service and a visit is charged as
  // that service, once per copy (#986).
  app.events.subscribe('record.request_closed', async (message, tx) => {
    const { payload } = message;
    const requestId = idOf(message.entityId);
    const encounterId = idOf(payload.encounterId);
    const patientId = idOf(payload.patientId);
    const serviceId = idOf(payload.serviceId);
    const copies = payload.copies;
    if (!requestId || !encounterId || !patientId || !serviceId) return;
    if (payload.outcome !== 'fulfilled' || typeof copies !== 'number' || copies < 1) return;
    await postCharge(tx, {
      encounterId,
      patientId,
      serviceId,
      source: 'service',
      sourceRef: `record_request:${requestId}`,
      description: '',
      quantity: copies,
      unitPriceMinor: 0,
      flag: null,
    });
  });

  // A blood unit issued with a visit and a service is charged as that service, once per unit.
  app.events.subscribe('blood.unit_status_changed', async (message, tx) => {
    const { payload } = message;
    if (payload.to !== 'issued') return;
    const unitId = idOf(message.entityId);
    const encounterId = idOf(payload.encounterId);
    const patientId = idOf(payload.patientId);
    const serviceId = idOf(payload.serviceId);
    if (!unitId || !encounterId || !patientId || !serviceId) return;
    await postCharge(tx, {
      encounterId,
      patientId,
      serviceId,
      source: 'service',
      sourceRef: `blood:${unitId}`,
      description: '',
      quantity: 1,
      unitPriceMinor: 0,
      flag: null,
    });
  });

  // A surgery completed on a visit is charged as its procedure service (#178), once. A surgery
  // with no visit or no service has nothing to post; the price is the list's, never the surgery's.
  app.events.subscribe('surgery.completed', async (message, tx) => {
    const { payload } = message;
    const surgeryId = idOf(message.entityId);
    const encounterId = idOf(payload.encounterId);
    const patientId = idOf(payload.patientId);
    const serviceId = idOf(payload.serviceId);
    if (!surgeryId || !encounterId || !patientId || !serviceId) return;
    const booking = await bookingOf(tx, surgeryId);
    await postCharge(tx, {
      encounterId: booking.visitId ?? encounterId,
      ...(booking.doneOn ? { priceDate: booking.doneOn } : {}),
      patientId,
      serviceId,
      source: 'procedure',
      sourceRef: `surgery:${surgeryId}`,
      description: '',
      quantity: 1,
      unitPriceMinor: 0,
      flag: null,
    });
  });

  // Consumables and implants used in a surgery are charged for each batch taken, at that
  // batch's price, as a dispense is (#178). With no visit linked nothing is posted.
  app.events.subscribe('surgery.consumables_used', async (message, tx) => {
    const { payload } = message;
    const useId = idOf(payload.useId);
    const encounterId = idOf(payload.encounterId);
    const patientId = idOf(payload.patientId);
    if (!useId || !encounterId || !patientId) return;
    const surgeryId = idOf(message.entityId);
    const visitId = (surgeryId && (await bookingOf(tx, surgeryId)).visitId) || encounterId;
    const { rows } = await tx.execute<{
      id: string;
      quantity: number;
      item_name: string;
      mrp_minor: string | null;
    }>(
      sql`select c.id, c.quantity, d.generic_name as item_name, b.mrp_minor::text as mrp_minor
          from ot_consumables c
          join drugs d on d.tenant_id = c.tenant_id and d.id = c.drug_id
          join stock_batches b on b.tenant_id = c.tenant_id and b.id = c.batch_id
          where c.use_id = ${useId}
          order by c.id`,
    );
    for (const line of rows) {
      await postCharge(tx, {
        encounterId: visitId,
        patientId,
        serviceId: null,
        source: 'dispense',
        sourceRef: `theatre:${line.id}`,
        description: line.item_name,
        quantity: line.quantity,
        unitPriceMinor: line.mrp_minor === null ? 0 : Number(line.mrp_minor),
        flag: line.mrp_minor === null ? 'no_price' : null,
      });
    }
  });

  // Units of a surgery's consumables brought back (#892). What is still in use is the recorded
  // quantity less all returns, and each charge for more than that is dealt with: still pending, on
  // no draft and with nothing left in use, it is voided; any other is flagged for the billing desk
  // to credit. A charge carried by a relink already excludes what came back before it (#1243), and
  // one waiting for its credit after a relink keeps that flag, so it is never carried again.
  // Computed from all that has been returned, so a repeat changes nothing.
  app.events.subscribe('surgery.consumables_returned', async (message, tx) => {
    const consumableId = idOf(message.payload.consumableId);
    if (!consumableId) return;
    await tx.execute(
      sql`update charges c set
            flag = case when c.flag = 'relink_review' then c.flag else 'return_review' end,
            status = case when c.status = 'pending' and c.invoice_id is null
              and not ${BILLED} and r.in_use <= 0 then 'void' else c.status end
          from (select o.quantity - coalesce((select sum(t.quantity) from ot_consumable_returns t
                  where t.consumable_id = o.id), 0) as in_use
                from ot_consumables o where o.id = ${consumableId}) r
          where (c.source_ref = 'theatre:' || ${consumableId}::text
              or c.source_ref like 'theatre:' || ${consumableId}::text || ':%')
            and c.quantity > r.in_use and c.status <> 'void'`,
    );
  });

  // A surgery linked to another visit (#900). The procedure charge of a completed one is moved by
  // moveProcedureCharge (#1233). A charge never changes its visit, so those of its
  // consumables still pending and on no invoice are voided; all are posted on the new visit
  // (source_ref `theatre:<row>:<event id>`, once for each event). A charge on an invoice or a
  // draft stays on the old visit, flagged `relink_review` for the billing desk to credit. One
  // posted void because that visit was cancelled stays as it is and is charged on the new visit.
  app.events.subscribe('surgery.encounter_changed', async (message, tx) => {
    const surgeryId = idOf(message.entityId);
    const from = idOf(message.payload.fromEncounterId);
    const to = idOf(message.payload.encounterId);
    const patientId = idOf(message.payload.patientId);
    if (!surgeryId || !from || !to || !patientId || from === to) return;
    // Events can be handled out of order: what is moved goes to the visit the booking names now,
    // and nothing is moved off that visit.
    const booking = await bookingOf(tx, surgeryId);
    const target = booking.visitId ?? to;
    if (target === from) return;
    const { eventId } = message;
    const { doneOn } = booking;
    await moveProcedureCharge(tx, { surgeryId, from, to: target, patientId, eventId, doneOn });
    const { rows } = await tx.execute<{
      id: string;
      description: string;
      in_use: number;
      unit_price_minor: string;
      flag: 'no_price' | null;
      source_ref: string;
      movable: boolean;
      dropped: boolean;
    }>(
      sql`select c.id, c.description, c.unit_price_minor::text, c.flag, c.source_ref,
            (o.quantity - coalesce((select sum(t.quantity) from ot_consumable_returns t
              where t.consumable_id = o.id), 0))::int as in_use,
            (c.status = 'pending' and c.invoice_id is null and not ${BILLED}) as movable,
            (c.status = 'void') as dropped
          from charges c join ot_consumables o on c.source_ref = 'theatre:' || o.id::text
            or c.source_ref like 'theatre:' || o.id::text || ':%'
          where o.booking_id = ${surgeryId} and c.encounter_id = ${from}
            and (c.status <> 'void' or c.flag = 'visit_cancelled')
            and c.flag is distinct from 'relink_review'
          order by c.id
          for update of c`,
    );
    for (const charge of rows) {
      // Either way the new visit is charged; an old charge that cannot be voided stays, flagged
      // for the billing desk to credit, so the work is billed once on the right visit.
      if (!charge.dropped) {
        await tx.execute(
          charge.movable
            ? sql`update charges set status = 'void' where id = ${charge.id}`
            : sql`update charges set flag = 'relink_review' where id = ${charge.id}`,
        );
      }
      // What came back to stock before the move is not charged again. Counted from the recorded
      // quantity, as a charge carried before already excludes the earlier returns (#1243).
      if (charge.in_use <= 0) continue;
      const base = charge.source_ref.split(':').slice(0, 2).join(':');
      await postCharge(tx, {
        encounterId: target,
        patientId,
        serviceId: null,
        source: 'dispense',
        sourceRef: `${base}:${message.eventId}`,
        description: charge.description,
        quantity: charge.in_use,
        unitPriceMinor: Number(charge.unit_price_minor),
        flag:
          charge.flag === 'no_price' || (charge.dropped && Number(charge.unit_price_minor) === 0)
            ? 'no_price'
            : null,
      });
    }
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
              and not ${BILLED} and r.returned >= c.quantity then 'void' else c.status end
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
