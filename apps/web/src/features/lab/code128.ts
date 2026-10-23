/**
 * Code 128 (code set B), the barcode a sample's label carries (#90): the accession id, read by any
 * laboratory scanner. Each symbol is six widths, bar first, in modules (eleven a symbol); the stop
 * symbol has seven. Code set B holds the printable ASCII characters, which an accession id
 * (`YYMMDD-NNNN`) is made of.
 */
const PATTERNS = [
  '212222 222122 222221 121223 121322 131222 122213 122312 132212',
  '221213 221312 231212 112232 122132 122231 113222 123122 123221',
  '223211 221132 221231 213212 223112 312131 311222 321122 321221',
  '312212 322112 322211 212123 212321 232121 111323 131123 131321',
  '112313 132113 132311 211313 231113 231311 112133 112331 132131',
  '113123 113321 133121 313121 211331 231131 213113 213311 213131',
  '311123 311321 331121 312113 312311 332111 314111 221411 431111',
  '111224 111422 121124 121421 141122 141221 112214 112412 122114',
  '122411 142112 142211 241211 221114 413111 241112 134111 111242',
  '121142 121241 114212 124112 124211 411212 421112 421211 212141',
  '214121 412121 111143 111341 131141 114113 114311 411113 411311',
  '113141 114131 311141 411131 211412 211214 211232 2331112',
]
  .join(' ')
  .split(' ');

const START_B = 104;
const STOP = 106;
/** The blank required before and after the symbols, in modules. */
export const QUIET_ZONE = 10;

/** The symbol patterns, for tests. */
export const CODE128_PATTERNS: readonly string[] = PATTERNS;

/** The symbol values of a text in code set B, with the start, the check symbol and the stop. */
export function code128Values(text: string): number[] {
  const values = [...text].map((char) => {
    const code = char.charCodeAt(0);
    if (char.length !== 1 || code < 32 || code > 126) {
      throw new RangeError('Code 128 B holds printable ASCII only');
    }
    return code - 32;
  });
  const check = values.reduce((sum, value, index) => sum + value * (index + 1), START_B) % 103;
  return [START_B, ...values, check, STOP];
}

/**
 * The bars of a text: each one's start and width in modules, counted from the left edge of the
 * quiet zone, and the whole width with both quiet zones.
 */
export function code128Bars(text: string): { bars: { x: number; width: number }[]; width: number } {
  const bars: { x: number; width: number }[] = [];
  let x = QUIET_ZONE;
  for (const value of code128Values(text)) {
    [...PATTERNS[value]!].forEach((digit, index) => {
      const width = Number(digit);
      if (index % 2 === 0) bars.push({ x, width });
      x += width;
    });
  }
  return { bars, width: x + QUIET_ZONE };
}
