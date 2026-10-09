import { createFormatters } from './format';
import { plainSpaces } from '@/test/text';
import { dayBoundsUtc, nextDay, todayIn, utcToZoned, zonedToUtc } from './timezone';

const plain = plainSpaces;

const hospital = createFormatters({ locale: 'en-IN', timezone: 'Asia/Kolkata', currency: 'INR' });
const clinic = createFormatters({ locale: 'en-GB', timezone: 'Asia/Dubai', currency: 'AED' });

describe('formatters', () => {
  const instant = '2026-10-14T20:15:00Z';

  it('shows the same instant on each hospital’s own calendar day and clock', () => {
    // 20:15 UTC is already the next day in India, and just past midnight in Dubai.
    expect(plain(hospital.date(instant))).toBe('15 Oct 2026');
    expect(plain(hospital.time(instant))).toBe('1:45 am');
    expect(plain(hospital.dateTime(instant))).toBe('15 Oct 2026, 1:45 am');
    expect(plain(clinic.date(instant))).toBe('15 Oct 2026');
    expect(plain(clinic.time(instant))).toBe('00:15');
    expect(plain(clinic.dateTime(instant))).toBe('15 Oct 2026, 00:15');
  });

  it('accepts ISO strings, Date objects and epoch milliseconds', () => {
    const expected = hospital.dateTime(instant);
    expect(hospital.dateTime(new Date(instant))).toBe(expected);
    expect(hospital.dateTime(Date.parse(instant))).toBe(expected);
  });

  it('groups numbers the way the locale does', () => {
    expect(hospital.number(1234567.5)).toBe('12,34,567.5');
    expect(clinic.number(1234567.5)).toBe('1,234,567.5');
    expect(hospital.number(0.256, { style: 'percent', maximumFractionDigits: 1 })).toBe('25.6%');
  });

  it('formats money from minor units in the hospital’s currency', () => {
    expect(plain(hospital.money(12345678))).toBe('₹1,23,456.78');
    expect(plain(clinic.money(12345678))).toBe('AED 123,456.78');
    expect(plain(hospital.money(0))).toBe('₹0.00');
    expect(plain(hospital.money(-5050))).toBe('-₹50.50');
  });

  it('uses each currency’s own number of decimals', () => {
    const yen = createFormatters({ locale: 'ja-JP', timezone: 'Asia/Tokyo', currency: 'JPY' });
    const dinar = createFormatters({ locale: 'en-KW', timezone: 'Asia/Kuwait', currency: 'KWD' });
    // Yen has no minor unit, so 1500 minor units is 1500 yen.
    expect(plain(yen.money(1500))).toMatch(/1,500$/);
    expect(plain(yen.money(1500))).not.toContain('.');
    // The Kuwaiti dinar has three decimals: 1500 fils is 1.500 dinar.
    expect(plain(dinar.money(1500))).toContain('1.500');
  });

  it('falls back part by part when the config names something unknown', () => {
    const broken = createFormatters({
      locale: 'not a locale',
      timezone: 'Mars/Olympus',
      currency: 'NOPE',
    });
    // English, UTC, and a plain two-decimal number instead of a wrong currency.
    expect(plain(broken.dateTime('2026-10-14T20:15:00Z'))).toBe('Oct 14, 2026, 8:15 PM');
    expect(plain(broken.money(123456))).toBe('1,234.56');

    const badZoneOnly = createFormatters({
      locale: 'en-IN',
      timezone: 'Mars/Olympus',
      currency: 'INR',
    });
    expect(plain(badZoneOnly.money(100))).toBe('₹1.00');
    expect(plain(badZoneOnly.time('2026-10-14T20:15:00Z'))).toBe('8:15 pm');
  });

  it('has safe defaults when there is no hospital', () => {
    const none = createFormatters();
    expect(plain(none.dateTime('2026-10-14T20:15:00Z'))).toBe('Oct 14, 2026, 8:15 PM');
    expect(plain(none.money(123456))).toBe('1,234.56');
  });

  it('reuses formatters for the same config', () => {
    const config = { locale: 'en-GB', timezone: 'Asia/Dubai', currency: 'AED' };
    expect(createFormatters(config)).toBe(createFormatters({ ...config }));
    expect(createFormatters(config)).not.toBe(hospital);
  });
});

describe('timezone helpers', () => {
  it('knows which day it is at the hospital, not in the browser or in UTC', () => {
    const now = new Date('2026-10-14T20:15:00Z');
    expect(todayIn('UTC', now)).toBe('2026-10-14');
    expect(todayIn('Asia/Kolkata', now)).toBe('2026-10-15');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-10-14');
  });

  it('bounds a hospital day in UTC, with an exclusive end', () => {
    expect(dayBoundsUtc('2026-10-15', 'Asia/Kolkata')).toEqual({
      start: '2026-10-14T18:30:00.000Z',
      end: '2026-10-15T18:30:00.000Z',
    });
    expect(dayBoundsUtc('2026-10-15', 'Asia/Dubai')).toEqual({
      start: '2026-10-14T20:00:00.000Z',
      end: '2026-10-15T20:00:00.000Z',
    });
  });

  it('handles days that are not 24 hours long (daylight saving)', () => {
    const hours = ({ start, end }: { start: string; end: string }) =>
      (Date.parse(end) - Date.parse(start)) / 3_600_000;
    // London: clocks go forward on 29 March 2026 and back on 25 October 2026.
    expect(hours(dayBoundsUtc('2026-03-29', 'Europe/London'))).toBe(23);
    expect(hours(dayBoundsUtc('2026-10-25', 'Europe/London'))).toBe(25);
    expect(hours(dayBoundsUtc('2026-10-26', 'Europe/London'))).toBe(24);
    expect(nextDay('2026-10-25')).toBe('2026-10-26');
  });

  it('rolls over months and years', () => {
    expect(nextDay('2026-12-31')).toBe('2027-01-01');
    expect(nextDay('2028-02-28')).toBe('2028-02-29');
  });

  it('converts a date and time entered at the hospital to UTC and back', () => {
    const iso = zonedToUtc('2026-10-15', '09:30', 'Asia/Kolkata');
    expect(iso).toBe('2026-10-15T04:00:00.000Z');
    expect(utcToZoned(iso, 'Asia/Kolkata')).toEqual({ day: '2026-10-15', time: '09:30' });
    // The same instant is a different wall-clock time, and can be a different day, elsewhere.
    expect(utcToZoned(iso, 'Asia/Dubai')).toEqual({ day: '2026-10-15', time: '08:00' });
    expect(utcToZoned(iso, 'America/Los_Angeles')).toEqual({ day: '2026-10-14', time: '21:00' });
  });
});
