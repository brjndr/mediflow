import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AGE_UNITS,
  ageAtOrBefore,
  ageBefore,
  ageWithinMax,
  bandCovers,
  bandFor,
  bandForAge,
  bandsOverlap,
  dateAtAge,
  type Age,
  type AgeBand,
} from './age.js';

const age = (value: number, unit: Age['unit']): Age => ({ value, unit });
const band = (sex: string, from: Age, until?: Age): AgeBand => ({
  sex,
  ageFrom: from,
  ...(until ? { ageUntil: until } : {}),
});
const next = (date: string, days = 1) => dateAtAge(date, age(days, 'days'));

/** Every date of birth over five years that include a leap year. */
function birthdays(): string[] {
  const dates: string[] = [];
  for (let date = '2011-01-01'; date < '2016-01-01'; date = next(date)) dates.push(date);
  return dates;
}

describe('the day an age is reached', () => {
  it('counts days and weeks', () => {
    expect(dateAtAge('2024-02-28', age(0, 'days'))).toBe('2024-02-28');
    expect(dateAtAge('2024-02-28', age(1, 'days'))).toBe('2024-02-29');
    expect(dateAtAge('2023-02-28', age(1, 'days'))).toBe('2023-03-01');
    expect(dateAtAge('2023-12-25', age(1, 'weeks'))).toBe('2024-01-01');
    expect(dateAtAge('2023-12-25', age(7, 'days'))).toBe('2024-01-01');
  });

  it('lands on the same day of the month for months and years, whatever leap years lie between', () => {
    expect(dateAtAge('2012-03-15', age(12, 'years'))).toBe('2024-03-15');
    expect(dateAtAge('2012-03-15', age(144, 'months'))).toBe('2024-03-15');
    expect(dateAtAge('2023-11-15', age(3, 'months'))).toBe('2024-02-15');
    // Three leap days lie between: counting 12 x 365 days would be three days early.
    expect(dateAtAge('2012-03-15', age(12 * 365, 'days'))).toBe('2024-03-12');
  });

  it('lands on the last day of a month that is shorter', () => {
    expect(dateAtAge('2024-01-31', age(1, 'months'))).toBe('2024-02-29');
    expect(dateAtAge('2023-01-31', age(1, 'months'))).toBe('2023-02-28');
    expect(dateAtAge('2023-01-31', age(2, 'months'))).toBe('2023-03-31');
    expect(dateAtAge('2023-08-31', age(1, 'months'))).toBe('2023-09-30');
  });

  it('gives someone born on 29 February a birthday every year', () => {
    expect(dateAtAge('2012-02-29', age(12, 'years'))).toBe('2024-02-29');
    expect(dateAtAge('2012-02-29', age(1, 'years'))).toBe('2013-02-28');
    expect(dateAtAge('2012-02-29', age(13, 'years'))).toBe('2025-02-28');
  });

  it('refuses a date that is not one, and reads an early year as written', () => {
    for (const date of ['', '2024-2-9', '2023-02-29', '2024-13-01', '2024-00-10', 'yesterday']) {
      expect(() => dateAtAge(date, age(1, 'days'))).toThrow(RangeError);
    }
    expect(dateAtAge('0050-03-01', age(1, 'years'))).toBe('0051-03-01');
    expect(dateAtAge('1900-02-28', age(1, 'days'))).toBe('1900-03-01');
  });

  it('never goes back as the age grows, for any date of birth', () => {
    for (const unit of AGE_UNITS) {
      for (const born of birthdays().filter((_, index) => index % 13 === 0)) {
        let before = dateAtAge(born, age(0, unit));
        expect(before).toBe(born);
        for (let value = 1; value <= 40; value++) {
          const at = dateAtAge(born, age(value, unit));
          expect(at >= before).toBe(true);
          before = at;
        }
      }
    }
  });
});

describe('putting ages in order without a date of birth', () => {
  it('compares years with months, and weeks with days, exactly', () => {
    expect(ageAtOrBefore(age(12, 'months'), age(1, 'years'))).toBe(true);
    expect(ageAtOrBefore(age(1, 'years'), age(12, 'months'))).toBe(true);
    expect(ageBefore(age(12, 'months'), age(1, 'years'))).toBe(false);
    expect(ageBefore(age(23, 'months'), age(2, 'years'))).toBe(true);
    expect(ageAtOrBefore(age(2, 'weeks'), age(14, 'days'))).toBe(true);
    expect(ageBefore(age(13, 'days'), age(2, 'weeks'))).toBe(true);
    expect(ageBefore(age(2, 'weeks'), age(13, 'days'))).toBe(false);
  });

  it('takes birth to be before everything, in any unit', () => {
    for (const unit of AGE_UNITS) {
      expect(ageAtOrBefore(age(0, unit), age(0, 'days'))).toBe(true);
      expect(ageAtOrBefore(age(0, 'days'), age(0, unit))).toBe(true);
      expect(ageBefore(age(0, unit), age(1, 'days'))).toBe(true);
      expect(ageBefore(age(0, unit), age(1, 'years'))).toBe(true);
    }
  });

  it('orders months against days only when no date of birth can bring them together', () => {
    // A month is 28 to 31 days.
    expect(ageAtOrBefore(age(28, 'days'), age(1, 'months'))).toBe(true);
    expect(ageAtOrBefore(age(4, 'weeks'), age(1, 'months'))).toBe(true);
    expect(ageAtOrBefore(age(29, 'days'), age(1, 'months'))).toBe(false);
    expect(ageAtOrBefore(age(1, 'months'), age(30, 'days'))).toBe(false);
    expect(ageAtOrBefore(age(1, 'months'), age(31, 'days'))).toBe(true);
    expect(ageBefore(age(1, 'months'), age(31, 'days'))).toBe(false);
    expect(ageBefore(age(1, 'months'), age(32, 'days'))).toBe(true);
    // A year is 365 or 366 days.
    expect(ageAtOrBefore(age(365, 'days'), age(1, 'years'))).toBe(true);
    expect(ageAtOrBefore(age(1, 'years'), age(365, 'days'))).toBe(false);
    expect(ageAtOrBefore(age(1, 'years'), age(366, 'days'))).toBe(true);
  });

  it('is never contradicted by a real date of birth', () => {
    const ages = [
      ...[0, 1, 27, 28, 29, 30, 31, 32, 59, 62, 365, 366, 400, 730, 732].map((n) => age(n, 'days')),
      ...[0, 1, 4, 5, 52, 53].map((n) => age(n, 'weeks')),
      ...[0, 1, 2, 11, 12, 13, 24].map((n) => age(n, 'months')),
      ...[0, 1, 2].map((n) => age(n, 'years')),
    ];
    const born = birthdays().filter((_, index) => index % 5 === 0 || index > 1100);
    for (const a of ages) {
      for (const b of ages) {
        const atOrBefore = ageAtOrBefore(a, b);
        const before = ageBefore(a, b);
        if (!atOrBefore && !before) continue;
        for (const date of born) {
          const left = dateAtAge(date, a);
          const right = dateAtAge(date, b);
          if (atOrBefore && left > right) throw new Error(`${JSON.stringify([a, b, date])}`);
          if (before && left >= right) throw new Error(`${JSON.stringify([a, b, date])}`);
        }
      }
    }
  }, 60_000);

  it('knows the oldest age in each unit', () => {
    expect(ageWithinMax(age(150, 'years'))).toBe(true);
    expect(ageWithinMax(age(151, 'years'))).toBe(false);
    expect(ageWithinMax(age(1800, 'months'))).toBe(true);
    expect(ageWithinMax(age(1801, 'months'))).toBe(false);
    expect(ageWithinMax(age(7801, 'weeks'))).toBe(false);
    expect(ageWithinMax(age(54751, 'days'))).toBe(false);
    expect(ageWithinMax(age(-1, 'days'))).toBe(false);
  });
});

describe('ranges for the same people', () => {
  it('do not overlap when one ends where the other starts', () => {
    const child = band('any', age(1, 'months'), age(12, 'years'));
    expect(bandsOverlap(band('any', age(0, 'days'), age(1, 'months')), child)).toBe(false);
    expect(bandsOverlap(child, band('any', age(12, 'years')))).toBe(false);
    expect(bandsOverlap(child, band('any', age(144, 'months')))).toBe(false);
    expect(bandsOverlap(child, band('any', age(143, 'months')))).toBe(true);
    expect(bandsOverlap(child, band('any', age(0, 'days')))).toBe(true);
    // The order of the two does not matter.
    expect(bandsOverlap(band('any', age(12, 'years')), child)).toBe(false);
    expect(bandsOverlap(band('any', age(143, 'months')), child)).toBe(true);
  });

  it('overlap when only some dates of birth keep them apart', () => {
    const newborn = band('any', age(0, 'days'), age(1, 'months'));
    expect(bandsOverlap(newborn, band('any', age(30, 'days')))).toBe(true);
    expect(bandsOverlap(newborn, band('any', age(31, 'days')))).toBe(false);
    expect(
      bandsOverlap(band('any', age(0, 'days'), age(4, 'weeks')), band('any', age(1, 'months'))),
    ).toBe(false);
    expect(
      bandsOverlap(band('any', age(0, 'days'), age(5, 'weeks')), band('any', age(1, 'months'))),
    ).toBe(true);
  });

  it('never overlap between one sex and another', () => {
    expect(bandsOverlap(band('male', age(0, 'days')), band('female', age(0, 'days')))).toBe(false);
    expect(bandsOverlap(band('male', age(0, 'days')), band('any', age(0, 'days')))).toBe(false);
  });

  it('that pass the check hold for at most one, and ranges that meet leave no day out, for every date of birth', () => {
    const bands = [
      band('any', age(0, 'days'), age(4, 'weeks')),
      band('any', age(4, 'weeks'), age(6, 'months')),
      band('any', age(6, 'months'), age(1, 'years')),
      band('any', age(12, 'months'), age(2, 'years')),
      band('any', age(2, 'years')),
    ];
    for (const [index, one] of bands.entries()) {
      for (const other of bands.slice(index + 1)) expect(bandsOverlap(one, other)).toBe(false);
    }
    // Every fourth date of birth, and every one around the leap day.
    const born = birthdays().filter(
      (date, index) => index % 4 === 0 || (date >= '2012-02-20' && date <= '2012-03-05'),
    );
    for (const date of born) {
      // The day each range starts and ends for this person, then every day of two and a half
      // years of life against them.
      const spans = bands.map((one) => ({
        from: dateAtAge(date, one.ageFrom),
        until: one.ageUntil ? dateAtAge(date, one.ageUntil) : undefined,
      }));
      for (let on = date, day = 0; day < 920; on = next(on), day++) {
        const covering = spans.filter(
          (one) => one.from <= on && (one.until === undefined || on < one.until),
        );
        if (covering.length !== 1) throw new Error(`${date} on ${on}: ${covering.length}`);
      }
      // And the function the lookup uses agrees, on the days the ranges change.
      for (const [index, one] of spans.entries()) {
        const band = bands[index];
        if (!band) continue;
        expect(bandCovers(band, date, one.from)).toBe(true);
        if (one.until) expect(bandCovers(band, date, one.until)).toBe(false);
      }
    }
  }, 60_000);
});

describe('the range for a patient', () => {
  const bands = [
    band('any', age(0, 'days'), age(1, 'months')),
    band('any', age(1, 'months'), age(12, 'years')),
    band('male', age(12, 'years')),
    band('female', age(12, 'years')),
  ];

  it('changes on the birthday, not days before it', () => {
    // Born on a leap day, twelve in a leap year.
    expect(bandFor(bands, 'male', '2012-02-29', '2024-02-28')).toBe(bands[1]);
    expect(bandFor(bands, 'male', '2012-02-29', '2024-02-29')).toBe(bands[2]);
    // Three leap days after birth, and still a child the day before the birthday.
    expect(bandFor(bands, 'female', '2012-03-15', '2024-03-12')).toBe(bands[1]);
    expect(bandFor(bands, 'female', '2012-03-15', '2024-03-14')).toBe(bands[1]);
    expect(bandFor(bands, 'female', '2012-03-15', '2024-03-15')).toBe(bands[3]);
  });

  it('follows the length of the month of birth', () => {
    // Born in February of a year that is not a leap year: a month old after 28 days.
    expect(bandFor(bands, 'male', '2023-02-01', '2023-02-28')).toBe(bands[0]);
    expect(bandFor(bands, 'male', '2023-02-01', '2023-03-01')).toBe(bands[1]);
    // Born in January: a month old after 31.
    expect(bandFor(bands, 'male', '2023-01-01', '2023-01-31')).toBe(bands[0]);
    expect(bandFor(bands, 'male', '2023-01-01', '2023-02-01')).toBe(bands[1]);
    // On the day of birth.
    expect(bandFor(bands, 'male', '2023-01-01', '2023-01-01')).toBe(bands[0]);
  });

  it('uses the range for the sex before the one for anyone, and only the one for anyone otherwise', () => {
    const both = [band('any', age(0, 'days')), band('female', age(12, 'years'))];
    expect(bandFor(both, 'female', '2000-06-01', '2020-06-01')).toBe(both[1]);
    expect(bandFor(both, 'male', '2000-06-01', '2020-06-01')).toBe(both[0]);
    expect(bandFor(both, 'female', '2010-06-01', '2020-06-01')).toBe(both[0]);
    expect(bandFor(bands, 'other', '2000-06-01', '2020-06-01')).toBeUndefined();
    expect(bandFor(bands, 'other', '2015-06-01', '2020-06-01')).toBe(bands[1]);
    // Before the date of birth there is no range.
    expect(bandFor(bands, 'male', '2020-06-02', '2020-06-01')).toBeUndefined();
  });

  it('tries a typed age as someone born on the first of a 31-day month', () => {
    expect(bandForAge(bands, 'male', age(30, 'days'))).toBe(bands[0]);
    expect(bandForAge(bands, 'male', age(31, 'days'))).toBe(bands[1]);
    expect(bandForAge(bands, 'male', age(1, 'months'))).toBe(bands[1]);
    expect(bandForAge(bands, 'male', age(4, 'weeks'))).toBe(bands[0]);
    expect(bandForAge(bands, 'male', age(143, 'months'))).toBe(bands[1]);
    expect(bandForAge(bands, 'male', age(144, 'months'))).toBe(bands[2]);
    expect(bandForAge(bands, 'female', age(12, 'years'))).toBe(bands[3]);
    expect(bandForAge(bands, 'male', age(0, 'years'))).toBe(bands[0]);
  });
});

describe('the copy the web app holds', () => {
  // The API may not import from the web app, so the rule exists twice. Reading the other file is
  // not importing it: this only makes sure the two cannot drift apart unnoticed.
  const read = (relative: string) =>
    readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8')
      .split('\r\n')
      .join('\n');
  /** A file without its opening comment and its imports, which differ by design. */
  const body = (text: string) => text.slice(text.indexOf('export const AGE_UNITS'));
  const cases = (text: string) =>
    text
      .slice(text.indexOf('const age = (value'))
      .split("describe('the copy the web app holds'")[0] ?? '';

  it('has the same rule', () => {
    const web = read('../../../../web/src/features/lab-tests/age.ts');
    expect(body(read('./age.ts'))).toBe(body(web));
  });

  it('is tested with the same cases', () => {
    const web = read('../../../../web/src/features/lab-tests/age.test.ts');
    expect(cases(read('./age.test.ts')).trimEnd()).toBe(cases(web).trimEnd());
  });
});
