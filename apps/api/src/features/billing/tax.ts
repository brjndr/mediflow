import type pg from 'pg';

export const TAX_CLASSES = ['exempt', 'reduced', 'standard', 'higher'] as const;
export type TaxClass = (typeof TAX_CLASSES)[number];

/**
 * The rate of a class a hospital has not set, in basis points (1200 is 12%). The same defaults
 * purchasing starts a line with; a hospital's own rate (`tax_rates`) wins.
 */
export const DEFAULT_TAX_BP: Record<TaxClass, number> = {
  exempt: 0,
  reduced: 500,
  standard: 1200,
  higher: 1800,
};

/** The rate of every class for the hospital: its own where set, the default elsewhere. */
export async function taxRatesOf(client: pg.ClientBase): Promise<Record<TaxClass, number>> {
  const { rows } = await client.query<{ tax_class: TaxClass; rate_bp: number }>(
    'select tax_class, rate_bp from tax_rates',
  );
  const rates = { ...DEFAULT_TAX_BP };
  for (const row of rows) rates[row.tax_class] = row.rate_bp;
  return rates;
}
