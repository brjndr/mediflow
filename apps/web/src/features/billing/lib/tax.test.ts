import { describe, expect, it } from 'vitest';
import { bpToPercent, lineTaxMinor, percentToBp } from './tax';

describe('tax sums', () => {
  it('rounds the tax of a line half up', () => {
    expect(lineTaxMinor(1, 1050, 500)).toBe(53); // 0.525
    expect(lineTaxMinor(2, 10050, 1200)).toBe(2412);
    expect(lineTaxMinor(3, 1, 1200)).toBe(0);
    expect(lineTaxMinor(1, 100, 0)).toBe(0);
  });

  it('does not lose digits on a very large line', () => {
    expect(lineTaxMinor(10000, 100_000_000_000, 1800)).toBe(180_000_000_000_000);
  });

  it('reads a typed rate on its digits', () => {
    expect(percentToBp('12')).toBe(1200);
    expect(percentToBp('12.5')).toBe(1250);
    expect(percentToBp(' 0.05 ')).toBe(5);
    expect(percentToBp('100')).toBe(10000);
    for (const bad of ['', '12,5', '100.01', '101', '-1', '1.234', 'abc', '1e2', '.5']) {
      expect(percentToBp(bad)).toBeNull();
    }
  });

  it('writes a rate back as the text it was typed as', () => {
    expect(bpToPercent(1200)).toBe('12');
    expect(bpToPercent(1250)).toBe('12.5');
    expect(bpToPercent(5)).toBe('0.05');
    expect(bpToPercent(0)).toBe('0');
    expect(percentToBp(bpToPercent(1875))).toBe(1875);
  });
});
