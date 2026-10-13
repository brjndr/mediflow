import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HttpError } from './errors.js';
import {
  PLAIN_LINES,
  PLAIN_TEXT,
  tidy,
  tidyLines,
  tidyLinesOptional,
  tidyOptional,
  tidyWithin,
} from './text.js';

/** Text a person types that is stored and later printed: what is refused, and how it is stored. */

// The pattern as the validator compiles it: with the unicode flag.
const plain = new RegExp(PLAIN_TEXT, 'u');

describe('plain text', () => {
  it('takes what people write, in any script', () => {
    for (const text of [
      '',
      'Paracetamol 500 mg',
      'Café au lait',
      'हीमोग्लोबिन',
      // The joiners Indic scripts need, and an emoji made with one.
      'क्‍ष',
      'श्री‌',
      '👩‍⚕️',
      '10^3/uL',
    ]) {
      expect(plain.test(text), JSON.stringify(text)).toBe(true);
    }
  });

  it('refuses what would not read as it was typed', () => {
    for (const text of [
      'nul\u0000',
      'two\nlines',
      'a\ttab',
      'bell\u0007',
      'c1\u0085',
      'zero​width',
      'right‮to left',
      'pop‬',
      'isolate⁦',
      'bom﻿',
    ]) {
      expect(plain.test(text), JSON.stringify(text)).toBe(false);
    }
  });
});

describe('tidying', () => {
  it('trims, makes runs of spaces one, and puts the letters in one normal form', () => {
    expect(tidy('  Blood   glucose   fasting  ')).toBe('Blood glucose fasting');
    // "é" as one character and as e + a combining accent are the same text once stored.
    expect(tidy('Café')).toBe('Café');
    expect(tidy('Café')).toBe(tidy('Café'));
    expect(tidy('   ')).toBe('');
  });

  it('keeps optional text absent, never empty', () => {
    expect(tidyOptional(undefined, 10)).toBeNull();
    expect(tidyOptional('', 10)).toBeNull();
    expect(tidyOptional('   ', 10)).toBeNull();
    expect(tidyOptional('  g/dL ', 10)).toBe('g/dL');
  });

  it('refuses text that is too long once it is in its normal form', () => {
    expect(tidyWithin('x'.repeat(10), 10)).toHaveLength(10);
    // Spaces that go do not count.
    expect(tidyWithin(`  ${'x'.repeat(10)}  `, 10)).toHaveLength(10);
    // Counted in characters, as the database counts: an emoji is one.
    expect(tidyWithin('💊'.repeat(10), 10)).toBe('💊'.repeat(10));
    // A letter that the normal form writes as two: ten sent, twenty stored.
    const grows = 'क़'.repeat(10);
    expect([...grows.normalize('NFC')]).toHaveLength(20);
    for (const text of ['x'.repeat(11), grows]) {
      expect(() => tidyWithin(text, 10)).toThrow(HttpError);
      expect(() => tidyOptional(text, 10)).toThrow(/too long/);
    }
    expect(tidyWithin(grows, 20)).toBe(grows.normalize('NFC'));
  });
});

describe('text of several lines', () => {
  const lines = new RegExp(PLAIN_LINES, 'u');

  it('allows line breaks and nothing else that plain text refuses', () => {
    expect(lines.test('one\ntwo\r\nthree')).toBe(true);
    for (const text of [
      'a\ttab',
      `nul${String.fromCodePoint(0)}`,
      `bell${String.fromCodePoint(7)}`,
      String.fromCodePoint(0x200b),
      String.fromCodePoint(0x202e),
    ]) {
      expect(lines.test(text), JSON.stringify(text)).toBe(false);
    }
  });

  it('tidies each line, keeps one empty line between paragraphs, and none at the ends', () => {
    expect(tidyLines(' a   b \r\n\r\n\r\n c \n')).toBe('a b\n\nc');
    expect(tidyLines('one\rtwo')).toBe('one\ntwo');
    expect(tidyLinesOptional(undefined, 10)).toBeNull();
    expect(tidyLinesOptional(' \n \n', 10)).toBeNull();
    expect(tidyLinesOptional('ab\ncd', 5)).toBe('ab\ncd');
    expect(() => tidyLinesOptional('ab\ncde', 5)).toThrow(HttpError);
  });
});

describe('the web app', () => {
  it('checks its forms with the same two patterns', () => {
    // The API may not import from the web app, so both files are read as text: each writes a
    // pattern as a quoted string on one line.
    const patterns = (path: string) =>
      readFileSync(new URL(path, import.meta.url), 'utf8')
        .split('\n')
        .filter((line) => line.includes("]*$'"))
        .map((line) => line.slice(line.indexOf("'"), line.lastIndexOf("'") + 1));
    const here = patterns('./text.ts');
    expect(here).toHaveLength(2);
    expect(patterns('../../../../web/src/shared/utils/text.ts')).toEqual(here);
  });
});
