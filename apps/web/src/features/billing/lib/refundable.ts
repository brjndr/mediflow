import type { Payment } from '../types';

export interface Refundable {
  payment: Payment;
  /** What the payment still holds: what was taken less the refunds already made of it. */
  heldMinor: number;
}

/** The payments that still hold money, most recent first (the first is what a refund starts as). */
export function refundable(payments: readonly Payment[]): Refundable[] {
  return payments
    .filter((each) => each.kind === 'payment')
    .map((payment) => ({
      payment,
      heldMinor:
        payment.amountMinor -
        payments
          .filter((each) => each.kind === 'refund' && each.refundOf === payment.id)
          .reduce((sum, each) => sum + each.amountMinor, 0),
    }))
    .filter((each) => each.heldMinor > 0)
    .reverse();
}
