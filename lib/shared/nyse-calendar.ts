/** Return NYSE full-day holidays observed in a calendar year. */
function nyseHolidays(year: number): Set<string> {
  const holidays = new Set<string>();
  const add = (month: number, day: number) => holidays.add(`${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`);
  const weekdayOf = (month: number, day: number) => new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  const nthWeekday = (month: number, weekday: number, occurrence: number) => {
    const first = weekdayOf(month, 1);
    return 1 + ((weekday - first + 7) % 7) + 7 * (occurrence - 1);
  };
  const lastWeekday = (month: number, weekday: number) => {
    const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return lastDay - ((weekdayOf(month, lastDay) - weekday + 7) % 7);
  };
  const observedFixedHoliday = (month: number, day: number, saturdayObserved = true) => {
    const weekday = weekdayOf(month, day);
    if (weekday === 0) add(month, day + 1);
    else if (weekday === 6 && saturdayObserved) add(month, day - 1);
    else if (weekday !== 6) add(month, day);
  };

  // NYSE's New Year's Day rule differs from most federal holidays: Saturday
  // January 1 is not observed on the preceding Friday.
  observedFixedHoliday(1, 1, false);
  if (year >= 1998) add(1, nthWeekday(1, 1, 3)); // Martin Luther King Jr. Day
  add(2, nthWeekday(2, 1, 3)); // Washington's Birthday

  // Gregorian Easter computus; NYSE is closed on Good Friday.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const easterMonth = Math.floor((h + l - 7 * m + 114) / 31);
  const easterDay = ((h + l - 7 * m + 114) % 31) + 1;
  const goodFriday = new Date(Date.UTC(year, easterMonth - 1, easterDay - 2));
  holidays.add(goodFriday.toISOString().slice(0, 10));

  add(5, lastWeekday(5, 1)); // Memorial Day
  if (year >= 2022) observedFixedHoliday(6, 19); // Juneteenth
  observedFixedHoliday(7, 4); // Independence Day
  add(9, nthWeekday(9, 1, 1)); // Labor Day
  add(11, nthWeekday(11, 4, 4)); // Thanksgiving
  observedFixedHoliday(12, 25); // Christmas
  return holidays;
}

/** Count NYSE sessions after `start` through `end`, using UTC calendar dates. */
export function nyseSessionsBetween(start: Date, end: Date): number {
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start) return 0;

  const current = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  const holidaysByYear = new Map<number, Set<string>>();
  let sessions = 0;
  while (current < last) {
    current.setUTCDate(current.getUTCDate() + 1);
    const weekday = current.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;

    const year = current.getUTCFullYear();
    let holidays = holidaysByYear.get(year);
    if (!holidays) {
      holidays = nyseHolidays(year);
      holidaysByYear.set(year, holidays);
    }
    if (!holidays.has(current.toISOString().slice(0, 10))) sessions++;
  }
  return sessions;
}
