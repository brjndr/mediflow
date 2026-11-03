import type { FastifyRequest } from 'fastify';
import type { Permission } from '../../core/access/registry.js';
import { HttpError } from '../../core/http/errors.js';
import {
  creditNotesOf,
  findInvoice,
  num,
  paymentsOf,
  type ChargeRow,
  type CreditNoteRow,
  type InvoiceRow,
  type PaymentRow,
  type SessionRow,
} from './repository.js';
import type { Charge, CreditNote, Invoice, Payment, RegisterSession } from './schemas.js';

export const FEATURE = 'billing';

export const userIdOf = (request: FastifyRequest): string => {
  const userId = request.session?.userId;
  if (!userId) throw new HttpError(401, 'unauthenticated', 'No session');
  return userId;
};

/** The billing desk works the whole hospital's bills, so only the scope `all` reaches. */
export function requireAll(request: FastifyRequest, ...permissions: Permission[]): void {
  for (const permission of permissions) {
    if (request.access.scope(permission) !== 'all') {
      throw new HttpError(403, 'permission_denied', 'Billing needs the scope all');
    }
  }
}

export const invoiceNotFound = () => new HttpError(404, 'invoice_not_found', 'No such invoice');

const optional = <Key extends string, Value>(key: Key, value: Value | null | undefined) =>
  (value === null || value === undefined ? {} : { [key]: value }) as Partial<Record<Key, Value>>;

export const chargeView = (row: ChargeRow): Charge => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  source: row.source as Charge['source'],
  description: row.description,
  quantity: row.quantity,
  unitPriceMinor: num(row.unit_price_minor),
  totalMinor: num(row.total_minor),
  status: row.status as Charge['status'],
  ...optional('invoiceId', row.invoice_id),
  ...optional('flag', row.flag as Charge['flag'] | null),
  postedAt: row.posted_at.toISOString(),
});

export const invoiceView = (row: InvoiceRow): Invoice => ({
  id: row.id,
  tenantId: row.tenant_id,
  encounterId: row.encounter_id,
  patientId: row.patient_id,
  patientName: row.patient_name,
  patientMrn: row.patient_mrn,
  ...optional('number', row.number),
  status: row.status as Invoice['status'],
  lines: row.lines.map((line) => ({
    id: line.id,
    ...optional('chargeId', line.chargeId),
    source: line.source as Invoice['lines'][number]['source'],
    description: line.description,
    quantity: line.quantity,
    unitPriceMinor: line.unitPriceMinor,
    totalMinor: line.totalMinor,
  })),
  totalMinor: num(row.total_minor),
  paidMinor: num(row.paid_minor),
  creditedMinor: num(row.credited_minor),
  currency: row.currency,
  createdAt: row.created_at.toISOString(),
  ...(row.issued_at ? { issuedAt: row.issued_at.toISOString() } : {}),
  version: row.version,
});

export const paymentView = (row: PaymentRow): Payment => ({
  id: row.id,
  invoiceId: row.invoice_id,
  kind: row.kind as Payment['kind'],
  amountMinor: num(row.amount_minor),
  method: row.method as Payment['method'],
  ...optional('reference', row.reference),
  ...optional('refundOf', row.refund_of),
  ...optional('reason', row.reason),
  ...optional('sessionId', row.session_id),
  recordedByName: row.recorded_by_name,
  at: row.at.toISOString(),
});

export const creditNoteView = (row: CreditNoteRow): CreditNote => ({
  id: row.id,
  invoiceId: row.invoice_id,
  number: row.number,
  amountMinor: num(row.amount_minor),
  reason: row.reason,
  createdByName: row.created_by_name,
  createdAt: row.created_at.toISOString(),
});

export function sessionView(row: SessionRow): RegisterSession {
  const expected = num(row.expected_minor);
  const counted = row.counted_minor === null ? null : num(row.counted_minor);
  return {
    id: row.id,
    openedByName: row.opened_by_name,
    openedAt: row.opened_at.toISOString(),
    openingMinor: num(row.opening_minor),
    ...(row.closed_at ? { closedAt: row.closed_at.toISOString() } : {}),
    expectedMinor: expected,
    ...(counted === null ? {} : { countedMinor: counted, differenceMinor: counted - expected }),
    ...optional('note', row.note),
    totals: row.totals.map((total) => ({
      method: total.method as RegisterSession['totals'][number]['method'],
      paidMinor: num(total.paidMinor),
      refundedMinor: num(total.refundedMinor),
    })),
  };
}

/** The invoice as it is now, audited as a read. */
export async function invoiceAnswer(request: FastifyRequest, id: string): Promise<Invoice> {
  const row = await findInvoice(request.txClient, id);
  if (!row) throw invoiceNotFound();
  request.audit('read', 'invoice', row.id);
  return invoiceView(row);
}

export async function paymentsAnswer(request: FastifyRequest, invoiceId: string) {
  return (await paymentsOf(request.txClient, invoiceId)).map(paymentView);
}

export async function creditNotesAnswer(request: FastifyRequest, invoiceId: string) {
  return (await creditNotesOf(request.txClient, invoiceId)).map(creditNoteView);
}
