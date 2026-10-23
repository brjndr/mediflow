import { describe, expect, it } from 'vitest';
import { CODE128_PATTERNS, code128Bars, code128Values, QUIET_ZONE } from './code128';

const modules = (pattern: string) => [...pattern].reduce((sum, digit) => sum + Number(digit), 0);

describe('Code 128', () => {
  it('has 107 distinct symbols of eleven modules, and a stop of thirteen', () => {
    expect(CODE128_PATTERNS).toHaveLength(107);
    expect(new Set(CODE128_PATTERNS).size).toBe(107);
    CODE128_PATTERNS.slice(0, 106).forEach((pattern) => {
      expect(pattern).toHaveLength(6);
      expect(modules(pattern)).toBe(11);
    });
    expect(modules(CODE128_PATTERNS[106]!)).toBe(13);
  });

  it('starts in code set B, weights the check symbol by position and stops', () => {
    // 104 + 33*1 ("A") + 34*2 ("B") = 205, and 205 mod 103 = 102.
    expect(code128Values('AB')).toEqual([104, 33, 34, 102, 106]);
  });

  it('draws an accession id as bars inside the quiet zones', () => {
    const { bars, width } = code128Bars('261023-0001');
    // Start, eleven characters, the check symbol and the stop.
    expect(width).toBe(QUIET_ZONE * 2 + 11 * 13 + 13);
    expect(bars[0]).toEqual({ x: QUIET_ZONE, width: 2 });
    // Three bars a symbol, four in the stop, and the stop's last bar ends at the quiet zone.
    expect(bars).toHaveLength(3 * 13 + 4);
    const last = bars.at(-1)!;
    expect(last.x + last.width).toBe(width - QUIET_ZONE);
  });

  it('refuses a character outside code set B', () => {
    expect(() => code128Values('é')).toThrow(RangeError);
  });
});
