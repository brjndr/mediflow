import { afterEach, describe, expect, it } from 'vitest';
import { addDays, dayToWall, toWall, visibleDays, wallToDay, weekStartFor } from './zoned';

const previousTz = process.env.TZ;
afterEach(() => {
  process.env.TZ = previousTz;
});

describe('wall dates', () => {
  it('carry the hospital’s clock, whatever the browser’s timezone', () => {
    for (const browser of ['America/Los_Angeles', 'Asia/Kolkata', 'UTC']) {
      process.env.TZ = browser;
      // 03:30 UTC is 09:00 in Kolkata, and 07:30 in Dubai.
      const kolkata = toWall('2026-10-14T03:30:00Z', 'Asia/Kolkata');
      expect([kolkata.getDate(), kolkata.getHours(), kolkata.getMinutes()]).toEqual([14, 9, 0]);
      const dubai = toWall('2026-10-14T03:30:00Z', 'Asia/Dubai');
      expect([dubai.getHours(), dubai.getMinutes()]).toEqual([7, 30]);
    }
  });

  it('turn a calendar day into one and back', () => {
    process.env.TZ = 'America/New_York';
    // The day the clocks go back in New York: noon is on the day still.
    expect(wallToDay(dayToWall('2026-11-01'))).toBe('2026-11-01');
    expect(wallToDay(dayToWall('2026-03-08'))).toBe('2026-03-08');
  });
});

describe('visible days', () => {
  it('are the day itself in the day view', () => {
    expect(visibleDays('day', '2026-10-14', 1)).toEqual({ from: '2026-10-14', to: '2026-10-14' });
  });

  it('are the week holding the day, from the locale’s first day', () => {
    // 2026-10-14 is a Wednesday.
    expect(visibleDays('week', '2026-10-14', 1)).toEqual({ from: '2026-10-12', to: '2026-10-18' });
    expect(visibleDays('week', '2026-10-14', 0)).toEqual({ from: '2026-10-11', to: '2026-10-17' });
    expect(visibleDays('week', '2026-10-11', 1)).toEqual({ from: '2026-10-05', to: '2026-10-11' });
    // Across the end of a year.
    expect(visibleDays('week', '2027-01-01', 1)).toEqual({ from: '2026-12-28', to: '2027-01-03' });
  });

  it('move by calendar days', () => {
    expect(addDays('2026-10-31', 1)).toBe('2026-11-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });
});

describe('the first day of the week', () => {
  it('follows the region of the locale, the same in every browser', () => {
    expect(weekStartFor('en-IN')).toBe(0);
    expect(weekStartFor('hi-IN')).toBe(0);
    expect(weekStartFor('en-US')).toBe(0);
    expect(weekStartFor('en-GB')).toBe(1);
    expect(weekStartFor('fr-FR')).toBe(1);
    expect(weekStartFor('ar-AE')).toBe(6);
  });

  it('takes the likely region of a language alone, and Monday for an unknown locale', () => {
    // English alone is the US's.
    expect(weekStartFor('en')).toBe(0);
    expect(weekStartFor('fr')).toBe(1);
    expect(weekStartFor('not a locale')).toBe(1);
  });
});
