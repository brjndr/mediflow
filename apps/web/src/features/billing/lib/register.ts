import type { RegisterSession, RegisterTotal } from '../types';

/** The payment modes in the order the register shows them; a mode with no movement is left out. */
const ORDER: RegisterTotal['method'][] = ['cash', 'card', 'upi', 'bank', 'other'];

export function totalsInOrder(session: RegisterSession): RegisterTotal[] {
  return ORDER.flatMap((method) => session.totals.filter((each) => each.method === method));
}

/** What a mode took less what it gave back. */
export const netOf = (total: RegisterTotal): number => total.paidMinor - total.refundedMinor;

/** The cash taken and refunded by a session: only cash goes in the drawer. */
export function cashOf(session: RegisterSession): { takenMinor: number; refundedMinor: number } {
  const cash = session.totals.find((each) => each.method === 'cash');
  return { takenMinor: cash?.paidMinor ?? 0, refundedMinor: cash?.refundedMinor ?? 0 };
}

/**
 * Whether the figures of a session reconcile: the cash the drawer should hold is its opening cash
 * plus the cash taken less the cash refunded (the server works it out; the screen shows the sum).
 */
export function reconciles(session: RegisterSession): boolean {
  const { takenMinor, refundedMinor } = cashOf(session);
  return session.openingMinor + takenMinor - refundedMinor === session.expectedMinor;
}

/** The count against what was expected: counted less expected, as the server keeps it. */
export function differenceKind(differenceMinor: number): 'exact' | 'short' | 'over' {
  return differenceMinor === 0 ? 'exact' : differenceMinor < 0 ? 'short' : 'over';
}

/** Refusals of the API that have words of their own, by the screen that can meet them. */
export const OPEN_REFUSALS: ReadonlySet<string> = new Set(['register_open']);
export const CLOSE_REFUSALS: ReadonlySet<string> = new Set([
  'register_closed',
  'session_not_found',
]);

/** The count against what was expected, in words (never only a colour or a sign). */
export function differenceText(
  differenceMinor: number,
  t: (key: string, options?: Record<string, unknown>) => string,
  money: (minor: number) => string,
): string {
  const kind = differenceKind(differenceMinor);
  return kind === 'exact'
    ? t('register.difference.exact')
    : t(`register.difference.${kind}`, { amount: money(Math.abs(differenceMinor)) });
}
