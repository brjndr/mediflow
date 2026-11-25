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
  'departments',
  'doctors',
  'staff',
  'services',
  'drugs',
  'lab-tests',
  'templates',
  'codes',
  'wards',
  'notices',
  'admissions',
  'nursing',
  'blood-bank',
  'records',
  'insurance',
  'roster',
  'emergency',
  'ambulances',
  'theatre',
  'documents',
  'consents',
  'housekeeping',
  'hospital-settings',
  'audit-log',
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

// Dashboard widgets carry their strings beside the widget (#735, #969): the Hindi file of each
// must match its English one, so a widget never shows a gap in Hindi (#1103).
const widgetFiles = import.meta.glob<{ default: Tree }>(
  '../../features/*/widget-strings{,.hi}.json',
  { eager: true },
);

describe.each(
  Object.keys(widgetFiles)
    .filter((path) => path.endsWith('widget-strings.json'))
    .map((path) => path.replace('widget-strings.json', '')),
)('Hindi widget strings in %s', (dir) => {
  it('match the English keys and placeholders', () => {
    const hindiFile = widgetFiles[`${dir}widget-strings.hi.json`];
    expect(hindiFile, 'widget-strings.hi.json is missing').toBeDefined();
    const english = flatten(widgetFiles[`${dir}widget-strings.json`]!.default);
    const hindi = flatten(hindiFile!.default);
    expect(Object.keys(hindi).sort()).toEqual(Object.keys(english).sort());
    for (const [key, text] of Object.entries(english)) {
      expect(placeholders(hindi[key] ?? ''), key).toEqual(placeholders(text));
    }
  });
});
