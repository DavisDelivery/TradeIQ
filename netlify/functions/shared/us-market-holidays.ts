// Phase 6 PR-H — US equity market holiday calendar (NYSE).
//
// Used by the Prophet after-close scheduled scan (and any future
// scheduled job) to skip days the market is closed and avoid producing
// a junk snapshot that would overwrite the prior good one.
//
// Set: NYSE 2024 → 2028 holidays. Bounded list, easy to maintain. When
// the calendar runs out the helper returns false (no skip), so a
// missed update gracefully degrades to "scan anyway" rather than
// "never scan." The next holiday-list update is a five-minute task.
//
// Holidays included (per NYSE):
//   New Year's Day  · Martin Luther King Jr. Day · Washington's Birthday
//   Good Friday     · Memorial Day               · Juneteenth
//   Independence Day· Labor Day                  · Thanksgiving
//   Christmas
//
// Federal holidays falling on Saturday/Sunday observed on Friday/Monday
// per NYSE rule. The hard-coded dates already reflect observed dates.

const HOLIDAYS: Set<string> = new Set([
  // 2024
  '2024-01-01', '2024-01-15', '2024-02-19', '2024-03-29', '2024-05-27',
  '2024-06-19', '2024-07-04', '2024-09-02', '2024-11-28', '2024-12-25',
  // 2025
  '2025-01-01', '2025-01-20', '2025-02-17', '2025-04-18', '2025-05-26',
  '2025-06-19', '2025-07-04', '2025-09-01', '2025-11-27', '2025-12-25',
  // 2026
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25',
  '2026-06-19', '2026-07-03', '2026-09-07', '2026-11-26', '2026-12-25',
  // 2027
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31',
  '2027-06-18', '2027-07-05', '2027-09-06', '2027-11-25', '2027-12-24',
  // 2028
  '2028-01-17', '2028-02-21', '2028-04-14', '2028-05-29',
  '2028-06-19', '2028-07-04', '2028-09-04', '2028-11-23', '2028-12-25',
]);

/** True for Saturday or Sunday in UTC. */
export function isWeekend(date: Date): boolean {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

/**
 * True if `date` is a US equity (NYSE) market holiday. Date interpretation
 * uses the calendar-day portion (UTC) — the NYSE-closed predicate is keyed
 * by the day, not the time-of-day.
 */
export function isUSMarketHoliday(date: Date): boolean {
  const iso = date.toISOString().slice(0, 10);
  return HOLIDAYS.has(iso);
}

/** True if the market is closed on `date` (weekend OR holiday). */
export function isMarketClosed(date: Date): boolean {
  return isWeekend(date) || isUSMarketHoliday(date);
}

/** Test seam — exported list for unit tests to walk. */
export const _holidaySet = HOLIDAYS;
