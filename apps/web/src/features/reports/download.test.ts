import { describe, expect, it } from 'vitest';
import { downloadAddress } from './download';

describe('where a signed link is opened', () => {
  it('puts a path of the API under the API’s own base', () => {
    expect(downloadAddress('/report-files/rep_1?expires=1&signature=x')).toBe(
      `${window.location.origin}/api/report-files/rep_1?expires=1&signature=x`,
    );
  });

  it('keeps an https address, as a link to object storage will be', () => {
    expect(downloadAddress('https://files.example.test/a.csv?sig=x')).toBe(
      'https://files.example.test/a.csv?sig=x',
    );
  });

  it('does not follow a plain http or script address to another place', () => {
    expect(downloadAddress('http://evil.example.test/a.csv')).toBe(
      `${window.location.origin}/api/evil.example.test/a.csv`,
    );
    expect(downloadAddress('javascript:alert(1)')).toBe(`${window.location.origin}/api/alert(1)`);
  });
});
