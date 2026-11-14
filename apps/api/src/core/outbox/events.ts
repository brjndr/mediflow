/**
 * The domain events core and feature modules publish (CLAUDE.md, "Domain events"). Each carries
 * the hospital, the entity id, the actor and a timestamp. Payloads hold ids and codes, never
 * patient data.
 */
export const DOMAIN_EVENTS = [
  'patient.registered',
  'patient.updated',
  // Two records of one person were merged (#194): the merge and both patient ids, nothing else.
  'patient.merged',
  // A merge was undone inside its window (#555): the merge and both patient ids, nothing else.
  'patient.unmerged',
  // A correction to a record was requested or decided (#556): ids and the target kind only.
  'correction.requested',
  'correction.approved',
  'correction.rejected',
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
  // What a consultation asks to happen next (#88): ids and codes only, never the reason or note.
  'referral.created',
  'referral.cancelled',
  'followup.created',
  'followup.booked',
  'followup.cancelled',
  'lab.sample_collected',
  // A sample was rejected, so its order is collected again as a new sample (#90).
  'lab.sample_rejected',
  'lab.result_verified',
  'lab.critical_value',
  // A doctor acknowledged a verified critical result (#92).
  'lab.critical_acknowledged',
  // Radiology's study of an imaging order (#96): ids and the modality, never the slot.
  'imaging.scheduled',
  'imaging.unscheduled',
  'imaging.performed',
  // A report signed (#97), and an addendum to a signed one: ids only, never the text.
  'imaging.reported',
  'imaging.addendum_added',
  'pharmacy.dispensed',
  // A counter sale and the return of some of it (#101): ids only, never an item or a price.
  'pharmacy.sold',
  'pharmacy.sale_returned',
  // Units of a dispense brought back, to stock or wasted (#104): ids only, never a quantity.
  'pharmacy.dispense_returned',
  // An approved stock adjustment moved stock (#102): ids and the reason, never a quantity.
  'stock.adjusted',
  'stock.low',
  'stock.expiring',
  // Purchasing (#103): an order approved, goods received against it and goods sent back to the
  // supplier: ids and the reason, never an item, a quantity or a cost.
  'purchase.order_approved',
  'stock.received',
  'stock.returned',
  // An issue voucher against an indent moved stock from a store to the place that asked (#105):
  // the indent, the voucher and the two places, never an item or a quantity.
  'stock.issued',
  'charge.posted',
  'invoice.issued',
  'invoice.paid',
  'payment.refunded',
  // A credit note against an issued invoice, and a cash register session settled (#114): ids only.
  'invoice.credited',
  'register.closed',
  'admission.created',
  'bed.assigned',
  'bed.released',
  // A bed was held for a patient, or the hold ended (#582): ids and how it ended, never a note.
  'bed.reserved',
  'bed.reservation_ended',
  'medication.administered',
  // Nursing and ward care (BE-24): ids and the kind or outcome, never text.
  'progressnote.created',
  'progressnote.updated',
  'ward.stockrequested',
  // Fluid balance and care plans (NR-04): ids, the direction or the status, never an amount or text.
  'fluid.recorded',
  'careplan.created',
  'careplan.task_done',
  'careplan.closed',
  'discharge.completed',
  // An admission made by mistake was cancelled (#573): ids only, never the reason.
  'admission.cancelled',
  // Operations (#200): ids and codes only.
  'roster.shift_scheduled',
  'roster.shift_cancelled',
  'roster.leave_requested',
  'roster.leave_approved',
  'roster.leave_rejected',
  'roster.leave_cancelled',
  'blood.unit_registered',
  'blood.unit_status_changed',
  'ambulance.trip_requested',
  'ambulance.trip_status_changed',
  'cleaning.task_created',
  'cleaning.task_completed',
  // Emergency cases (BE-26): ids and the category only, never the complaint.
  'er.registered',
  'er.triaged',
  'er.identified',
  'er.unidentified',
  'er.started',
  'er.disposed',
  'er.medico_legal',
  // Operation theatre (BE-27): ids only, never the procedure or a note.
  'surgery.scheduled',
  'surgery.started',
  'surgery.completed',
  'surgery.cancelled',
  'surgery.consumables_used',
  // Units of consumables brought back to stock (#892): ids only, never a quantity or a reason.
  'surgery.consumables_returned',
  // A surgery linked to another visit (#900): ids only; billing moves its consumable charges.
  'surgery.encounter_changed',
  'surgery.checklist_step_completed',
  // A recovery-room note added (#917): ids only, never the text or the pain score.
  'surgery.recovery_note_added',
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

/** Keys that name patient data; a payload never carries them, whatever the value. */
const FORBIDDEN_KEYS = new Set([
  'name',
  'firstname',
  'lastname',
  'fullname',
  'phone',
  'mobile',
  'email',
  'address',
  'dob',
  'dateofbirth',
  'birthdate',
  'mrn',
  'note',
  'notes',
  'text',
  'comment',
  'body',
  'content',
  'description',
  'diagnosis',
  'complaint',
  'chiefcomplaint',
  'allergies',
  'password',
  'secret',
]);

const KEY_PATTERN = /^[a-zA-Z][a-zA-Z0-9]{0,39}$/;
/** An id, a code, a number or a timestamp: one token, so a sentence of free text cannot pass. */
const TOKEN_PATTERN = /^\S{1,64}$/;
const MAX_LIST = 50;

const scalarOk = (value: unknown): boolean =>
  value === null ||
  typeof value === 'boolean' ||
  (typeof value === 'number' && Number.isFinite(value)) ||
  (typeof value === 'string' && TOKEN_PATTERN.test(value));

/**
 * Payloads are copied into the job queue's table, which has no row-level security, so they hold
 * ids, codes, numbers and timestamps only (#253). The rule is structural: a flat object whose
 * values are single tokens (or a short list of them) under keys that do not name patient data.
 * The error names the event and the key, never the value.
 */
export function assertEventPayload(event: DomainEvent, payload: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(payload)) {
    if (!KEY_PATTERN.test(key) || FORBIDDEN_KEYS.has(key.toLowerCase())) {
      throw new Error(`event_payload_key_refused: ${event}.${key}`);
    }
    if (value === undefined) continue;
    const ok = Array.isArray(value)
      ? value.length <= MAX_LIST && value.every(scalarOk)
      : scalarOk(value);
    if (!ok) throw new Error(`event_payload_value_refused: ${event}.${key}`);
  }
}
