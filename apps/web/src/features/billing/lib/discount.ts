import type { Discount } from '../types';

/**
 * Discounts on an invoice (#116). The server works every amount out; the sums here are for what
 * the screen shows before a draft is saved, and follow the server's: a percentage is of what the
 * discount comes off, rounded half up, and a bill discount is spread over the lines in whole
 * units by the largest remainder. They use bigint, since a line can pass what a number holds
 * exactly.
 */

/** What a discount takes off `base`, or null when it would take more than that. */
export function discountTaken(base: bigint, discount: Discount | undefined): bigint | null {
  if (!discount) return 0n;
  const taken =
    discount.kind === 'percent'
      ? (base * BigInt(discount.value) * 2n + 10000n) / 20000n
      : BigInt(discount.value);
  return taken > base ? null : taken;
}

/** Spreads `total` over the bases in proportion; the shares add up to `total` exactly. */
export function spread(bases: bigint[], total: bigint): bigint[] {
  const sum = bases.reduce((a, b) => a + b, 0n);
  if (total === 0n || sum === 0n) return bases.map(() => 0n);
  const shares = bases.map((base) => (base * total) / sum);
  const order = bases
    .map((base, index) => ({ index, remainder: (base * total) % sum }))
    .sort((a, b) =>
      a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
    );
  let left = total - shares.reduce((a, b) => a + b, 0n);
  for (const { index } of order) {
    if (left <= 0n) break;
    shares[index] = (shares[index] ?? 0n) + 1n;
    left -= 1n;
  }
  return shares;
}

export interface PreviewLine {
  /** What the line costs before any discount. */
  totalMinor: number;
  discount?: Discount;
}

export interface Preview {
  /** Per line: what its own discount takes, and its share of the bill discount. */
  own: number[];
  shares: number[];
  /** Line discounts and the bill discount together. */
  discountMinor: number;
  grossMinor: number;
  /** True when a discount would take more than it comes off. */
  exceeds: boolean;
}

/** The discounts of a bill as the server will work them out. */
export function previewDiscounts(lines: readonly PreviewLine[], bill?: Discount): Preview {
  let exceeds = false;
  const own = lines.map((line) => {
    const taken = discountTaken(BigInt(line.totalMinor), line.discount);
    if (taken === null) exceeds = true;
    return taken ?? 0n;
  });
  const bases = lines.map((line, index) => BigInt(line.totalMinor) - (own[index] ?? 0n));
  const billTotal = discountTaken(
    bases.reduce((a, b) => a + b, 0n),
    bill,
  );
  if (billTotal === null) exceeds = true;
  const shares = spread(bases, billTotal ?? 0n);
  const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
  return {
    own: own.map(Number),
    shares: shares.map(Number),
    discountMinor: Number(sum(own) + sum(shares)),
    grossMinor: lines.reduce((total, line) => total + line.totalMinor, 0),
    exceeds,
  };
}

/** Tax on what is left of a line after its discounts, rounded half up. */
export function taxOnNet(netMinor: number, rateBp: number): number {
  return Number((BigInt(netMinor) * BigInt(rateBp) + 5000n) / 10000n);
}

/** Whether a discount is more than the hospital lets through without approval. */
export function aboveLimit(discountMinor: number, grossMinor: number, limitBp: number): boolean {
  return BigInt(discountMinor) * 10000n > BigInt(limitBp) * BigInt(grossMinor);
}
