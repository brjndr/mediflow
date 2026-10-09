/**
 * Hospital-specific values (names, currency, locale, timezone) must come from the tenant config.
 * This scan fails when app source hardcodes one. Mocks, tests and comments are exempt.
 */
const sources = import.meta.glob<string>('/src/**/*.{ts,tsx}', {
  query: '?raw',
  import: 'default',
  eager: true,
});

const EXEMPT = /\.test\.|\/test\/|\/mocks\//;

const FORBIDDEN: [what: string, pattern: RegExp][] = [
  ['a currency code', /['"`](INR|AED|USD|EUR|GBP|SAR|QAR|KWD|JPY)['"`]/],
  ['a currency symbol next to a number', /[₹$€£]\s?\d/],
  ['a region-specific locale', /['"`][a-z]{2}-[A-Z]{2}['"`]/],
  ['a timezone', /['"`](Asia|Europe|America|Africa|Australia|Pacific)\/[A-Za-z_]+['"`]/],
  ['a hospital name', /Sample Hospital|Riverside Clinic/],
];

/** Removes block and line comments, where examples such as 'en-IN' are welcome. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

describe('no hardcoded hospital values', () => {
  it('finds none in app source', () => {
    const found: string[] = [];
    let scanned = 0;
    for (const [path, source] of Object.entries(sources)) {
      if (EXEMPT.test(path)) continue;
      scanned++;
      const code = withoutComments(source);
      for (const [what, pattern] of FORBIDDEN) {
        const match = pattern.exec(code);
        if (match) found.push(`${path}: ${what} (${match[0]})`);
      }
    }
    expect(found).toEqual([]);
    // Guards the scan itself against silently matching no files.
    expect(scanned).toBeGreaterThan(40);
  });

  it('would catch each kind of value', () => {
    const samples = [
      "format(amount, 'INR')",
      'const label = `₹${amount}`.replace("x", "₹5")',
      "new Intl.NumberFormat('en-IN')",
      "{ timeZone: 'Asia/Kolkata' }",
      '<h1>Sample Hospital</h1>',
    ];
    for (const sample of samples) {
      expect(
        FORBIDDEN.some(([, pattern]) => pattern.test(withoutComments(sample))),
        sample,
      ).toBe(true);
    }
    // A comment that mentions an example is fine.
    expect(
      FORBIDDEN.some(([, pattern]) =>
        pattern.test(withoutComments("locale: string; // e.g. 'en-IN'")),
      ),
    ).toBe(false);
  });
});
