import { describe, expect, it } from 'vitest';
import billingEn from '@/features/billing/locales/en.json';
import billingHi from '@/features/billing/locales/hi.json';
import clinicalEn from '@/features/clinical/locales/en.json';
import clinicalHi from '@/features/clinical/locales/hi.json';
import triageEn from '@/features/triage/locales/en.json';
import triageHi from '@/features/triage/locales/hi.json';

function flatten(tree: unknown, prefix = ''): Record<string, string> {
  if (typeof tree === 'string') return { [prefix]: tree };
  return Object.entries(tree as Record<string, unknown>).reduce<Record<string, string>>(
    (all, [key, value]) => ({ ...all, ...flatten(value, prefix ? `${prefix}.${key}` : key) }),
    {},
  );
}
const placeholders = (text: string) => [...text.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]).sort();
const base = (key: string) => key.replace(/_(one|other)$/, '');

// The Hindi files carry the strings of the printed documents only (#771); anything else falls
// back to English per key. What they hold must be a key English has, with the same placeholders.
describe.each([
  ['billing', billingEn, billingHi],
  ['clinical', clinicalEn, clinicalHi],
  ['triage', triageEn, triageHi],
])('Hindi print strings of %s', (_name, en, hi) => {
  const english = flatten(en);
  const hindi = flatten(hi);
  it('are keys English has, with the same placeholders', () => {
    const englishBases = new Set(Object.keys(english).map(base));
    for (const [key, text] of Object.entries(hindi)) {
      expect(englishBases.has(base(key)), key).toBe(true);
      const match = english[key] ?? english[`${key}`];
      if (match) expect(placeholders(text), key).toEqual(placeholders(match));
    }
  });
});
