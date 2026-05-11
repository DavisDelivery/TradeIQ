// US equity market trading calendar — NYSE/NASDAQ shared schedule.
//
// Why hardcoded:
//   The NYSE-published holiday calendar is small, stable, and known years in
//   advance. A backtest runs deterministically only if every reader agrees
//   on the calendar — pulling from an external source on each run defeats
//   PIT integrity. We freeze the canonical list here and bump when NYSE
//   announces future years.
//
// Coverage: 2018-2027 (Phase 4 needs through 2026 + buffer for forward
// returns).
//
// Includes: full closures only. Early-close days (Black Friday, Christmas
// Eve etc.) trade normally for daily-bar backtests and are not excluded.

// Full-day market closures (YYYY-MM-DD). Source: NYSE published calendar.
const HOLIDAYS = new Set<string>([
  // 2018
  '2018-01-01', // New Year's Day
  '2018-01-15', // MLK Day
  '2018-02-19', // Presidents' Day
  '2018-03-30', // Good Friday
  '2018-05-28', // Memorial Day
  '2018-07-04', // Independence Day
  '2018-09-03', // Labor Day
  '2018-11-22', // Thanksgiving
  '2018-12-05', // National Day of Mourning (G.H.W. Bush)
  '2018-12-25', // Christmas
  // 2019
  '2019-01-01',
  '2019-01-21',
  '2019-02-18',
  '2019-04-19',
  '2019-05-27',
  '2019-07-04',
  '2019-09-02',
  '2019-11-28',
  '2019-12-25',
  // 2020
  '2020-01-01',
  '2020-01-20',
  '2020-02-17',
  '2020-04-10',
  '2020-05-25',
  '2020-07-03', // observed
  '2020-09-07',
  '2020-11-26',
  '2020-12-25',
  // 2021
  '2021-01-01',
  '2021-01-18',
  '2021-02-15',
  '2021-04-02',
  '2021-05-31',
  '2021-07-05', // observed
  '2021-09-06',
  '2021-11-25',
  '2021-12-24', // observed (Christmas on Sat)
  // 2022
  '2022-01-17', // MLK (Jan 1 was Sat, no observance)
  '2022-02-21',
  '2022-04-15',
  '2022-05-30',
  '2022-06-20', // Juneteenth observed (first year)
  '2022-07-04',
  '2022-09-05',
  '2022-11-24',
  '2022-12-26', // observed
  // 2023
  '2023-01-02', // observed
  '2023-01-16',
  '2023-02-20',
  '2023-04-07',
  '2023-05-29',
  '2023-06-19',
  '2023-07-04',
  '2023-09-04',
  '2023-11-23',
  '2023-12-25',
  // 2024
  '2024-01-01',
  '2024-01-15',
  '2024-02-19',
  '2024-03-29',
  '2024-05-27',
  '2024-06-19',
  '2024-07-04',
  '2024-09-02',
  '2024-11-28',
  '2024-12-25',
  // 2025
  '2025-01-01',
  '2025-01-09', // National Day of Mourning (Jimmy Carter)
  '2025-01-20',
  '2025-02-17',
  '2025-04-18',
  '2025-05-26',
  '2025-06-19',
  '2025-07-04',
  '2025-09-01',
  '2025-11-27',
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-01-19',
  '2026-02-16',
  '2026-04-03',
  '2026-05-25',
  '2026-06-19',
  '2026-07-03', // observed (July 4 is Sat)
  '2026-09-07',
  '2026-11-26',
  '2026-12-25',
  // 2027 buffer
  '2027-01-01',
  '2027-01-18',
  '2027-02-15',
  '2027-03-26',
  '2027-05-31',
  '2027-06-18', // observed
  '2027-07-05', // observed
  '2027-09-06',
  '2027-11-25',
  '2027-12-24', // observed
]);

/** YYYY-MM-DD → 0-Sun..6-Sat. UTC-safe so result is independent of TZ. */
function dayOfWeek(yyyymmdd: string): number {
  // Parse as UTC noon to avoid DST/timezone shifts.
  return new Date(`${yyyymmdd}T12:00:00Z`).getUTCDay();
}

export function isWeekend(yyyymmdd: string): boolean {
  const d = dayOfWeek(yyyymmdd);
  return d === 0 || d === 6;
}

export function isHoliday(yyyymmdd: string): boolean {
  return HOLIDAYS.has(yyyymmdd);
}

export function isMarketOpen(yyyymmdd: string): boolean {
  return !isWeekend(yyyymmdd) && !isHoliday(yyyymmdd);
}

/** Add `n` calendar days to a YYYY-MM-DD date string. n may be negative. */
export function addDays(yyyymmdd: string, n: number): string {
  const d = new Date(`${yyyymmdd}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Smallest trading day strictly after `yyyymmdd`. */
export function nextTradingDay(yyyymmdd: string): string {
  let d = addDays(yyyymmdd, 1);
  while (!isMarketOpen(d)) d = addDays(d, 1);
  return d;
}

/** Largest trading day on or before `yyyymmdd`. */
export function prevOrCurrentTradingDay(yyyymmdd: string): string {
  let d = yyyymmdd;
  while (!isMarketOpen(d)) d = addDays(d, -1);
  return d;
}

/** All trading days in [from, to], inclusive. */
export function tradingDaysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  if (from > to) return out;
  let d = from;
  while (d <= to) {
    if (isMarketOpen(d)) out.push(d);
    d = addDays(d, 1);
  }
  return out;
}

/** Compare two YYYY-MM-DD as strings — safe because ISO is lexicographic. */
export function dateCmp(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
