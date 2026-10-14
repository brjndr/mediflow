import { describe, expect, it } from 'vitest';
import { PLAIN_LINES, PLAIN_TEXT } from './text';

// The API's own tests hold the full list; these say that the form refuses what it refuses.
const withPoint = (point: number) => `Para${String.fromCodePoint(point)}cetamol`;

describe('plain text in a form', () => {
  it('refuses what prints as nothing, as the API does (#322)', () => {
    for (const point of [0x00ad, 0x200b, 0x200e, 0x2060, 0x202e, 0xfeff, 0xe0041]) {
      expect(PLAIN_TEXT.test(withPoint(point)), point.toString(16)).toBe(false);
      expect(PLAIN_LINES.test(withPoint(point)), point.toString(16)).toBe(false);
    }
  });

  it('allows the Indic joiners, emoji and line breaks where they belong', () => {
    for (const point of [0x200c, 0x200d, 0xfe0f, 0x1f48a]) {
      expect(PLAIN_TEXT.test(withPoint(point)), point.toString(16)).toBe(true);
    }
    expect(PLAIN_TEXT.test('one\ntwo')).toBe(false);
    expect(PLAIN_LINES.test('one\ntwo')).toBe(true);
  });
});
