import type { StatusTone } from '@/shared/ui/status-badge';
import type { Invoice } from '../types';

export type InvoiceState = Invoice['status'] | 'discarded';

/** What a person is told: a void invoice that was a draft discarded is "Discarded" (#1240). */
export const invoiceState = (invoice: Invoice): InvoiceState =>
  invoice.discardedAt ? 'discarded' : invoice.status;

/** The tone an invoice's state is drawn in, as a `StatusBadge`. */
export const INVOICE_TONE: Record<InvoiceState, StatusTone> = {
  draft: 'neutral',
  issued: 'info',
  paid: 'success',
  void: 'danger',
  discarded: 'neutral',
};
