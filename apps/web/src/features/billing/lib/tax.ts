/**
 * Tax on an invoice line (#119). Rates are in basis points (1200 is 12%) and the server works the
 * tax out; the sums here are for what the screen shows before a draft is saved, and follow the
 * server's: units times price times rate, rounded half up, per line. They use bigint, since a
 * line can pass what a number holds exactly.
 */

export function lineTaxMinor(quantity: number, unitPriceMinor: number, rateBp: number): number {
  const product = BigInt(quantity) * BigInt(unitPriceMinor) * BigInt(rateBp);
  return Number((product + 5000n) / 10000n);
}

/**
 * A typed rate such as "12" or "12.5" as basis points, or null when it is not a percentage from
 * 0 to 100 with at most two decimals. Read on its digits, never through a float; a comma is
 * refused.
 */
export function percentToBp(text: string): number | null {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!match) return null;
  const whole = Number(match[1]);
  const fraction = Number((match[2] ?? '').padEnd(2, '0'));
  const bp = whole * 100 + fraction;
  return bp <= 10000 ? bp : null;
}

/** Basis points as the text of a percentage to edit: 1200 is "12", 1250 is "12.5". */
export function bpToPercent(bp: number): string {
  const whole = Math.floor(bp / 100);
  const fraction = String(bp % 100)
    .padStart(2, '0')
    .replace(/0+$/, '');
  return fraction === '' ? String(whole) : `${whole}.${fraction}`;
}

/** The tax of an invoice by rate, lowest rate first: what the print sheet and the page total. */
export function taxByRate(
  lines: readonly { taxRateBp: number; taxMinor: number }[],
): { rateBp: number; taxMinor: number }[] {
  const sums = new Map<number, number>();
  for (const line of lines) {
    if (line.taxRateBp > 0)
      sums.set(line.taxRateBp, (sums.get(line.taxRateBp) ?? 0) + line.taxMinor);
  }
  return [...sums]
    .map(([rateBp, taxMinor]) => ({ rateBp, taxMinor }))
    .sort((a, b) => a.rateBp - b.rateBp);
}
