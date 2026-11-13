import { describe, expect, it } from 'vitest';
import en from './en/common.json';
import hi from './hi/common.json';

function flatten(tree: unknown, prefix = ''): Record<string, string> {
  if (typeof tree === 'string') return { [prefix]: tree };
  return Object.entries(tree as Record<string, unknown>).reduce<Record<string, string>>(
    (all, [key, value]) => ({ ...all, ...flatten(value, prefix ? `${prefix}.${key}` : key) }),
    {},
  );
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]).sort();

describe('Hindi core strings', () => {
  const english = flatten(en);
  const hindi = flatten(hi);

  it('has every key the English file has, and no others', () => {
    expect(Object.keys(hindi).sort()).toEqual(Object.keys(english).sort());
  });

  it('keeps the placeholders of every string', () => {
    for (const [key, text] of Object.entries(english)) {
      expect(placeholders(hindi[key] ?? ''), key).toEqual(placeholders(text));
    }
  });
});
