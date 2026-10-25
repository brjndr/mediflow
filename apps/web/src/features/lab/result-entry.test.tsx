import { screen } from '@testing-library/react';
import i18next from 'i18next';
import { describe, expect, it } from 'vitest';
import { renderWithProviders } from '@/test/render';
import { ResultFlag } from './components/ResultFlag';
import en from './locales/en.json';
import { rangeWords } from './range-words';
import { DECIMAL, entrySchema, RESULT_FLAGS } from './schemas';

/**
 * Result entry (#93): what the form takes before anything is sent, a range in words, and the
 * API's flag as a word with an icon. The flag itself is never worked out in the browser (#91).
 */

const row = (value: string, overrides: { numeric?: boolean; comment?: string } = {}) => ({
  labTestId: 'lab_h_hb',
  numeric: overrides.numeric ?? true,
  value,
  comment: overrides.comment ?? '',
});

const messages = (rows: ReturnType<typeof row>[]) => {
  const parsed = entrySchema.safeParse({ rows });
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('the number a numeric test takes', () => {
  it.each(['5', '5.10', '-0.25', '0', '123456789', '1.123456'])('takes %s', (value) => {
    expect(DECIMAL.test(value)).toBe(true);
  });

  it.each(['1,5', '.5', '5.', '1e3', '+5', '1234567890', '1.1234567', '5 g/dL', ''])(
    'refuses %s',
    (value) => {
      expect(DECIMAL.test(value)).toBe(false);
    },
  );
});

describe('the entry form', () => {
  it('takes a number, keeping it as typed', () => {
    const parsed = entrySchema.parse({ rows: [row(' 5.10 ')] });
    expect(parsed.rows[0]?.value).toBe('5.10');
  });

  it('refuses a number in another format', () => {
    expect(messages([row('5,1')])).toEqual(['lab:results.errors.number']);
  });

  it('takes lines of words for a text test, and refuses a control character in them', () => {
    expect(messages([row('Pale yellow,\nclear', { numeric: false })])).toEqual([]);
    expect(messages([row('clear\u0007', { numeric: false })])).toEqual(['validation.plain_text']);
  });

  it('takes some tests filled in and others left for later', () => {
    expect(messages([row('13.2'), row('', { numeric: false })])).toEqual([]);
  });

  it('refuses an entry with no result at all', () => {
    expect(messages([row(''), row('  ')])).toEqual(['lab:results.errors.none']);
  });

  it('refuses a comment with no result', () => {
    expect(messages([row('13'), row('', { comment: 'Haemolysed slightly' })])).toEqual([
      'lab:results.errors.commentNeedsValue',
    ]);
  });
});

describe('a range in words', () => {
  const words = async (range: Parameters<typeof rangeWords>[0]) => {
    const i18n = i18next.createInstance();
    await i18n.init({ lng: 'en', ns: ['lab'], resources: { en: { lab: en } } });
    return rangeWords(range, i18n.getFixedT('en', 'lab'), String);
  };

  it('gives both limits, then the critical ones and the note', async () => {
    expect(
      await words({ low: 12, high: 15.5, criticalLow: 7, criticalHigh: 20, note: 'Adult female' }),
    ).toBe('12 to 15.5; critical at or below 7; critical at or above 20; Adult female');
  });

  it('gives one limit when the range has one', async () => {
    expect(await words({ high: 100 })).toBe('up to 100');
    expect(await words({ low: 5 })).toBe('5 or more');
  });

  it('gives nothing for a test with no range', async () => {
    expect(await words(undefined)).toBe('');
  });
});

describe('a result’s flag', () => {
  it.each([
    ['normal', 'Normal', false],
    ['low', 'Low', true],
    ['high', 'High', true],
    ['critical_low', 'Critical low', true],
    ['critical_high', 'Critical high', true],
  ] as const)('says %s in words, with an icon where it is not normal', async (flag, word, icon) => {
    renderWithProviders(<ResultFlag flag={flag} />);
    const shown = await screen.findByText(word);
    expect(shown.querySelector('svg') !== null).toBe(icon);
  });

  it('covers every flag the API gives', () => {
    expect(RESULT_FLAGS).toEqual(['normal', 'low', 'high', 'critical_low', 'critical_high']);
  });

  it('shows nothing for a result with no flag', async () => {
    const { container } = renderWithProviders(
      <>
        <span>No flag</span>
        <ResultFlag flag={undefined} />
      </>,
    );
    await screen.findByText('No flag');
    expect(container.querySelector('svg')).toBeNull();
    expect(screen.queryByText(/normal|low|high/i)).toBeNull();
  });
});
