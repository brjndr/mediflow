import type { TaxClass } from '../drugs/schemas.js';

/**
 * The rate a line starts with, by the item's tax class, in basis points (1200 is 12%). The web
 * app and its mock hold a copy for the order form: this one decides.
 */
export const DEFAULT_GST_BP: Record<TaxClass, number> = {
  exempt: 0,
  reduced: 500,
  standard: 1200,
  higher: 1800,
};

/**
 * The tax on a line in minor units, rounded half up: units × cost × rate / 10,000. It is
 * worked in bigint, as a line can pass what a number holds exactly. The same sum is in SQL
 * (`TAX_SQL`), for the totals of the lists.
 */
export function lineTax(quantity: number, unitCostMinor: number, rateBp: number): number {
  const product = BigInt(quantity) * BigInt(unitCostMinor) * BigInt(rateBp);
  return Number((product + 5000n) / 10000n);
}

/**
 * The same sum in SQL, for a line aliased `alias`. numeric rounds half away from zero, as the
 * sum above does for the non-negative amounts the columns allow (their checks refuse less).
 */
export const taxSql = (alias: string) =>
  `round(${alias}.quantity::numeric * ${alias}.unit_cost_minor * ${alias}.gst_rate_bp / 10000)`;

export type Supply = 'intra_state' | 'inter_state' | 'unknown';

export interface TaxSplit {
  supply: Supply;
  cgstMinor?: number;
  sgstMinor?: number;
  igstMinor?: number;
}

/**
 * How the tax divides: CGST and SGST in halves when the supplier's GSTIN and the hospital's
 * begin with the same state code, IGST when they differ. Without both numbers it is not
 * guessed. An odd minor unit goes to SGST. The split is of the document's tax, shown, not stored.
 */
export function splitTax(
  taxMinor: number,
  supplierGstin: string | null,
  hospitalGstin: string | null,
): TaxSplit {
  if (!supplierGstin || !hospitalGstin) return { supply: 'unknown' };
  if (supplierGstin.slice(0, 2) !== hospitalGstin.slice(0, 2)) {
    return { supply: 'inter_state', igstMinor: taxMinor };
  }
  const cgst = Math.floor(taxMinor / 2);
  return { supply: 'intra_state', cgstMinor: cgst, sgstMinor: taxMinor - cgst };
}
