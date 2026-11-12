import type { StatusTone } from '@/shared/ui/status-badge';
import type { Invoice } from '../types';

/** The tone an invoice's status is drawn in, as a `StatusBadge`. */
export const INVOICE_TONE: Record<Invoice['status'], StatusTone> = {
  draft: 'neutral',
  issued: 'info',
  paid: 'success',
  void: 'danger',
};
