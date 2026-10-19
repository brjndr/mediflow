/**
 * The domain events core and feature modules publish (CLAUDE.md, "Domain events"). Each carries
 * the hospital, the entity id, the actor and a timestamp. Payloads hold ids and codes, never
 * patient data.
 */
export const DOMAIN_EVENTS = [
  'patient.registered',
  'patient.updated',
  'appointment.created',
  'appointment.rescheduled',
  'appointment.cancelled',
  'appointment.completed',
  'appointment.no_show',
  'encounter.opened',
  'encounter.closed',
  // An encounter opened by mistake was cancelled, with nothing on its record.
  'encounter.cancelled',
  'queue.token_issued',
  'queue.called',
  'vitals.recorded',
  // A patient's allergy list was replaced: the version, never the allergies.
  'allergy.updated',
  'order.placed',
  'order.cancelled',
  'order.completed',
  'lab.sample_collected',
  'lab.result_verified',
  'lab.critical_value',
  'imaging.reported',
  'pharmacy.dispensed',
  'stock.low',
  'stock.expiring',
  'charge.posted',
  'invoice.issued',
  'invoice.paid',
  'payment.refunded',
  'admission.created',
  'bed.assigned',
  'bed.released',
  'medication.administered',
  'discharge.completed',
  'er.triaged',
  'surgery.completed',
  'claim.submitted',
  'claim.settled',
  // A record of a catalog (a service, a price, later a drug, a test, a bed) was added or changed.
  'master.changed',
] as const;

export type DomainEvent = (typeof DOMAIN_EVENTS)[number];

/** What a subscriber receives. Handlers must be idempotent: `eventId` identifies the event. */
export interface DomainEventMessage {
  eventId: string;
  tenantId: string;
  event: DomainEvent;
  entityId: string | null;
  actorId: string | null;
  occurredAt: string;
  payload: Record<string, unknown>;
}

/** The queue an event is delivered on. */
export const eventQueue = (event: DomainEvent): string => `event.${event}`;
