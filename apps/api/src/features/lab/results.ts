import type { LabResultFlagValue } from './schemas.js';

/** A limit of a reference range, as `lab-tests` keeps it. */
export interface RangeLimits {
  low?: number;
  high?: number;
  criticalLow?: number;
  criticalHigh?: number;
  note?: string;
}

// Up to nine digits before the point and six after, so it is below a thousand million.
const DECIMAL = /^-?\d{1,9}(\.\d{1,6})?$/;

/** A typed number as the database takes it, its decimals kept, or null when it is not one. */
export function decimalOf(text: string): string | null {
  const value = text.trim();
  return DECIMAL.test(value) ? value : null;
}

/**
 * A number read against its range: at or below the critical low, at or above the critical high,
 * then below the low, above the high, else normal. A critical limit lies strictly beyond its
 * normal limit (#310), so no value falls in two of these.
 */
export function flagOf(value: number, range: RangeLimits): LabResultFlagValue {
  if (range.criticalLow !== undefined && value <= range.criticalLow) return 'critical_low';
  if (range.criticalHigh !== undefined && value >= range.criticalHigh) return 'critical_high';
  if (range.low !== undefined && value < range.low) return 'low';
  if (range.high !== undefined && value > range.high) return 'high';
  return 'normal';
}

export const isCritical = (flag: LabResultFlagValue | null) =>
  flag === 'critical_low' || flag === 'critical_high';
