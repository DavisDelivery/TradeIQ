// Phase 6 PR-H — US market holiday calendar tests.

import { describe, it, expect } from 'vitest';
import { isUSMarketHoliday, isWeekend, isMarketClosed, _holidaySet } from '../us-market-holidays';

describe('isWeekend', () => {
  it('returns true for Saturday and Sunday (UTC)', () => {
    expect(isWeekend(new Date('2026-05-30T12:00:00Z'))).toBe(true);  // Sat
    expect(isWeekend(new Date('2026-05-31T12:00:00Z'))).toBe(true);  // Sun
  });
  it('returns false for weekdays', () => {
    expect(isWeekend(new Date('2026-05-29T12:00:00Z'))).toBe(false); // Fri
    expect(isWeekend(new Date('2026-06-01T12:00:00Z'))).toBe(false); // Mon
  });
});

describe('isUSMarketHoliday', () => {
  it('catches the canonical NYSE-closed days through 2028', () => {
    // 2025
    expect(isUSMarketHoliday(new Date('2025-01-01T15:00:00Z'))).toBe(true); // New Year's
    expect(isUSMarketHoliday(new Date('2025-07-04T15:00:00Z'))).toBe(true); // Independence
    expect(isUSMarketHoliday(new Date('2025-12-25T15:00:00Z'))).toBe(true); // Christmas
    // 2026
    expect(isUSMarketHoliday(new Date('2026-04-03T15:00:00Z'))).toBe(true); // Good Friday
    expect(isUSMarketHoliday(new Date('2026-11-26T15:00:00Z'))).toBe(true); // Thanksgiving
    // 2027
    expect(isUSMarketHoliday(new Date('2027-09-06T15:00:00Z'))).toBe(true); // Labor Day
  });
  it('returns false for ordinary weekdays', () => {
    expect(isUSMarketHoliday(new Date('2026-05-29T15:00:00Z'))).toBe(false);
    expect(isUSMarketHoliday(new Date('2026-07-15T15:00:00Z'))).toBe(false);
  });
});

describe('isMarketClosed', () => {
  it('skips weekends + holidays + ordinary weekdays correctly', () => {
    expect(isMarketClosed(new Date('2026-05-30T22:00:00Z'))).toBe(true);  // Sat
    expect(isMarketClosed(new Date('2026-11-26T22:00:00Z'))).toBe(true);  // Thanksgiving
    expect(isMarketClosed(new Date('2026-11-27T22:00:00Z'))).toBe(false); // Fri after T-giving
  });
});

describe('_holidaySet', () => {
  it('has the expected per-year cardinality (~9-10 days)', () => {
    const yearCounts: Record<string, number> = {};
    for (const iso of _holidaySet) {
      const y = iso.slice(0, 4);
      yearCounts[y] = (yearCounts[y] ?? 0) + 1;
    }
    for (const [y, n] of Object.entries(yearCounts)) {
      expect(n, `year ${y} count`).toBeGreaterThanOrEqual(9);
      expect(n, `year ${y} count`).toBeLessThanOrEqual(10);
    }
  });
});
