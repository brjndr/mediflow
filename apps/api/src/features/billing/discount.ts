import type pg from 'pg';
import { HttpError } from '../../core/http/errors.js';

/**
 * Discounts on invoices (#116). The desk types a percentage or an amount for a line or for the
 * whole bill, with a reason from a fixed list; the server works out every amount, spreads a bill
 * discount over the lines, and decides whether the result needs a second person's approval.
 * Money here is bigint: a line can reach 10^15 minor units, and a product with a rate more.
 */

export const DISCOUNT_REASONS = [
  'staff',
  'charity',
  'senior_citizen',
  'goodwill',
  'correction',
  'other',
] as const;
export type DiscountReason = (typeof DISCOUNT_REASONS)[number];

/** What the desk typed: `value` is basis points for a percentage, minor units for an amount. */
export interface DiscountInput {
  kind: 'percent' | 'amount';
  value: number;
  reason: DiscountReason;
}

/** The share of a bill discounted without approval, in basis points, when a hospital sets none. */
export const DEFAULT_DISCOUNT_LIMIT_BP = 500;

export const discountExceeds = () =>
  new HttpError(422, 'discount_exceeds', 'A discount is more than what it comes off');

/** Basis points of an amount, rounded half up. */
const share = (amount: bigint, bp: number): bigint => (amount * BigInt(bp) * 2n + 10000n) / 20000n;

/** What a discount takes off an amount of `base`; refused when it would take more than that. */
export function discountOf(base: bigint, discount: DiscountInput | null): bigint {
  if (!discount) return 0n;
  if (discount.kind === 'percent' && discount.value > 10000) {
    throw new HttpError(400, 'validation_failed', 'A percentage is at most 100');
  }
  const taken = discount.kind === 'percent' ? share(base, discount.value) : BigInt(discount.value);
  if (taken > base) throw discountExceeds();
  return taken;
}

/**
 * Spreads `total` over the bases in proportion to them, in whole minor units that add up to
 * `total` exactly: each takes the floor of its share and the leftover units go, one each, to the
 * largest remainders (the earlier line first on a tie).
 */
export function spread(bases: bigint[], total: bigint): bigint[] {
  const sum = bases.reduce((a, b) => a + b, 0n);
  if (total === 0n || sum === 0n) return bases.map(() => 0n);
  const shares = bases.map((base) => (base * total) / sum);
  const remainders = bases.map((base, index) => ({
    index,
    remainder: (base * total) % sum,
  }));
  let left = total - shares.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (const { index } of remainders) {
    if (left <= 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares;
}

/** Whether `discount` of a bill worth `gross` (both before tax) is above `limitBp`. */
export const aboveLimit = (discount: bigint, gross: bigint, limitBp: number): boolean =>
  discount * 10000n > BigInt(limitBp) * gross;

/** The hospital's limit; a hospital that never set one has the default. */
export async function discountLimitOf(client: pg.ClientBase): Promise<number> {
  const { rows } = await client.query<{ discount_limit_bp: number }>(
    'select discount_limit_bp from billing_settings',
  );
  return rows[0]?.discount_limit_bp ?? DEFAULT_DISCOUNT_LIMIT_BP;
}

export const columnsOf = (discount: DiscountInput | null) => ({
  bp: discount?.kind === 'percent' ? discount.value : null,
  amount: discount?.kind === 'amount' ? discount.value : null,
  reason: discount?.reason ?? null,
});

export function inputFrom(
  bp: number | null,
  amount: string | number | null,
  reason: string | null,
): DiscountInput | null {
  if (reason === null) return null;
  if (bp !== null) return { kind: 'percent', value: bp, reason: reason as DiscountReason };
  return { kind: 'amount', value: Number(amount), reason: reason as DiscountReason };
}
