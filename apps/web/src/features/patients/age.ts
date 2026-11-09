/** Age on a day, both given as YYYY-MM-DD calendar dates: whole years, and months under one. */
export function ageOn(dob: string, today: string): { years: number; months: number } {
  const [birthYear, birthMonth, birthDay] = dob.split('-').map(Number) as [number, number, number];
  const [year, month, day] = today.split('-').map(Number) as [number, number, number];
  const months = Math.max(
    (year - birthYear) * 12 + (month - birthMonth) - (day < birthDay ? 1 : 0),
    0,
  );
  return { years: Math.floor(months / 12), months };
}
