import { describe, expect, it } from 'vitest';
import { safeAppPath } from './safe-path';

describe('safeAppPath', () => {
  it.each([
    String.raw`/\evil.example`,
    String.raw`/\/evil.example`,
    '/%5Cevil.example',
    '/%5cevil.example',
    String.raw`//evil.example`,
    '/\t/evil.example',
    'https://evil.example',
    'evil',
    '',
  ])('refuses %j', (value) => {
    expect(safeAppPath(value)).toBe('/');
  });

  it('refuses non-strings', () => {
    expect(safeAppPath(undefined)).toBe('/');
    expect(safeAppPath(42)).toBe('/');
  });

  it('keeps a normal deep path and uses the fallback given', () => {
    expect(safeAppPath('/patients/abc?tab=notes')).toBe('/patients/abc?tab=notes');
    expect(safeAppPath('//x', '/home')).toBe('/home');
  });
});
