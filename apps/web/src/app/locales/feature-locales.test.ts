import { describe, expect, it } from 'vitest';

type Tree = string | { [key: string]: Tree };

function flatten(tree: Tree, prefix = ''): Record<string, string> {
  if (typeof tree === 'string') return { [prefix]: tree };
  return Object.entries(tree).reduce<Record<string, string>>(
    (all, [key, value]) => ({ ...all, ...flatten(value, prefix ? `${prefix}.${key}` : key) }),
    {},
  );
}

const placeholders = (text: string) => [...text.matchAll(/\{\{\w+\}\}/g)].map((m) => m[0]).sort();

// Features whose screens are fully translated to Hindi (#769). Each must have every key English
// has, with the same placeholders, so no raw key or missing value shows in Hindi.
const COMPLETE = [
  'patients',
  'appointments',
  'queue',
  'triage',
  'clinical',
  'lab',
  'radiology',
  'follow-ups',
  'pharmacy',
  'inventory',
  'purchasing',
  'indents',
  'billing',
  'reports',
  'imports',
  'roles',
  'hospital-profile',
];

const files = import.meta.glob<{ default: Tree }>('../../features/*/locales/{en,hi}.json', {
  eager: true,
});

describe.each(COMPLETE)('Hindi strings of %s', (feature) => {
  const english = flatten(files[`../../features/${feature}/locales/en.json`]!.default);
  const hindi = flatten(files[`../../features/${feature}/locales/hi.json`]!.default);

  it('has every key the English file has, and no others', () => {
    expect(Object.keys(hindi).sort()).toEqual(Object.keys(english).sort());
  });

  it('keeps the placeholders of every string and leaves none empty', () => {
    for (const [key, text] of Object.entries(english)) {
      expect(placeholders(hindi[key] ?? ''), key).toEqual(placeholders(text));
      expect((hindi[key] ?? '').trim(), key).not.toBe('');
    }
  });
});
