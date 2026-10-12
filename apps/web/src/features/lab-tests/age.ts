/**
 * Ages for reference ranges. An age limit is kept the way it is typed, a value with a unit
 * ("12 years", "6 weeks"), and a patient is compared with it on the calendar from the date of
 * birth: the limit is reached on the day that lies that long after the birth. So a patient moves
 * to the next range on the birthday whatever leap years lie between, and nothing is ever turned
 * into a count of days with an assumed length of month or year.
 *
 * Pure functions on ISO calendar dates (YYYY-MM-DD), with no timezone in them. The mock backend
 * uses this same file, so the form and the mock cannot disagree; the API keeps the same rules.
 */

export const AGE_UNITS = ['days', 'weeks', 'months', 'years'] as const;
export type AgeUnit = (typeof AGE_UNITS)[number];

export interface Age {
  value: number;
  unit: AgeUnit;
}

/** A range as far as ages go: from an age (included) until an age (not included), for a sex. */
export interface AgeBand {
  sex: string;
  ageFrom: Age;
  ageUntil?: Age;
}

/** The oldest age a limit can name, in each unit: 150 years. */
export const AGE_MAX: Record<AgeUnit, number> = {
  days: 54750,
  weeks: 7800,
  months: 1800,
  years: 150,
};

export const ageWithinMax = (age: Age) => age.value >= 0 && age.value <= AGE_MAX[age.unit];

/**
 * An age as whole months or as whole days: years are 12 months and weeks 7 days exactly, on any
 * calendar. Months and days cannot be turned into each other without a date of birth.
 */
function span(age: Age): { months: number; days: number } {
  if (age.unit === 'years') return { months: age.value * 12, days: 0 };
  if (age.unit === 'months') return { months: age.value, days: 0 };
  return { months: 0, days: age.unit === 'weeks' ? age.value * 7 : age.value };
}

// The fewest and the most days a number of months can take, for any date of birth. Loose on
// purpose: a bound that is too wide only refuses a pair of limits that could have been allowed.
const minDays = (months: number) => Math.floor(months / 12) * 365 + (months % 12) * 28;
const maxDays = (months: number) => Math.floor(months / 12) * 366 + (months % 12) * 31;

function ordered(a: Age, b: Age, orEqual: boolean): boolean {
  const x = span(a);
  const y = span(b);
  const less = (left: number, right: number) => (orEqual ? left <= right : left < right);
  if (x.months > 0 && y.months > 0) return less(x.months, y.months);
  if (x.months === 0 && y.months === 0) return less(x.days, y.days);
  return x.months > 0 ? less(maxDays(x.months), y.days) : less(x.days, minDays(y.months));
}

/** Whether age `a` is reached before age `b`, for every date of birth. */
export const ageBefore = (a: Age, b: Age) => ordered(a, b, false);
/** Whether age `a` is reached on the day age `b` is or before it, for every date of birth. */
export const ageAtOrBefore = (a: Age, b: Age) => ordered(a, b, true);

/**
 * Whether two bands for the same people could both hold for some patient. They cannot when one
 * ends at or before the age the other starts from, for every date of birth. Limits in months and
 * in days that only some dates of birth keep apart ("until 1 month" and "from 30 days") count as
 * overlapping: give the age where two ranges meet in the same unit.
 */
export function bandsOverlap(a: AgeBand, b: AgeBand): boolean {
  if (a.sex !== b.sex) return false;
  const aEndsFirst = a.ageUntil !== undefined && ageAtOrBefore(a.ageUntil, b.ageFrom);
  const bEndsFirst = b.ageUntil !== undefined && ageAtOrBefore(b.ageUntil, a.ageFrom);
  return !aEndsFirst && !bEndsFirst;
}

/** Roughly how many days an age is, to put ranges in order on screen. Never used to decide. */
export function ageOrder(age: Age): number {
  const { months, days } = span(age);
  return months * 30.4375 + days;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A UTC date from its parts. Not `Date.UTC`, which takes the years 0 to 99 for 1900 to 1999. */
function utcDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

const daysInMonth = (year: number, month: number) => utcDate(year, month, 0).getUTCDate();

/**
 * The calendar date on which someone born on `dateOfBirth` reaches an age. Days and weeks are
 * counted; months and years land on the same day of the month, or on its last day when the month
 * is shorter (born on 31 January, one month old on the last day of February; born on 29 February,
 * a year older on 28 February when the year has no 29th).
 */
export function dateAtAge(dateOfBirth: string, age: Age): string {
  const parts = ISO_DATE.exec(dateOfBirth);
  const year = Number(parts?.[1]);
  const month = Number(parts?.[2]);
  const day = Number(parts?.[3]);
  // A date that is not one is refused, never read as some other date.
  if (!parts || month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new RangeError('invalid_date');
  }
  const { months, days } = span(age);
  const total = year * 12 + (month - 1) + months;
  const atYear = Math.floor(total / 12);
  const atMonth = (total % 12) + 1;
  const atDay = Math.min(day, daysInMonth(atYear, atMonth));
  return utcDate(atYear, atMonth - 1, atDay + days)
    .toISOString()
    .slice(0, 10);
}

/** Whether a band holds for someone born on `dateOfBirth`, on the day `on`. */
export function bandCovers(band: AgeBand, dateOfBirth: string, on: string): boolean {
  if (dateAtAge(dateOfBirth, band.ageFrom) > on) return false;
  return band.ageUntil === undefined || on < dateAtAge(dateOfBirth, band.ageUntil);
}

/**
 * The band for a patient: the one for the patient's sex that covers the age on that day, else
 * the one for anyone. A patient whose sex is recorded as other gets only a band for anyone.
 */
export function bandFor<Band extends AgeBand>(
  bands: readonly Band[],
  sex: string,
  dateOfBirth: string,
  on: string,
): Band | undefined {
  const covering = bands.filter((band) => bandCovers(band, dateOfBirth, on));
  return covering.find((band) => band.sex === sex) ?? covering.find((band) => band.sex === 'any');
}

/**
 * A date of birth to try a typed age against, when there is no patient: the first day of a
 * 31-day month, in a year that is not a leap year. "30 days" is then under a month.
 */
export const SAMPLE_DATE_OF_BIRTH = '2001-01-01';

/** The band for someone of a typed age, taken as a person born on the sample date of birth. */
export function bandForAge<Band extends AgeBand>(
  bands: readonly Band[],
  sex: string,
  age: Age,
): Band | undefined {
  return bandFor(bands, sex, SAMPLE_DATE_OF_BIRTH, dateAtAge(SAMPLE_DATE_OF_BIRTH, age));
}
