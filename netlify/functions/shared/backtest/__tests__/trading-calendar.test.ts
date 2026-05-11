import { describe, it, expect } from 'vitest';
import {
  isMarketOpen,
  isHoliday,
  isWeekend,
  addDays,
  nextTradingDay,
  prevOrCurrentTradingDay,
  tradingDaysBetween,
} from '../trading-calendar';

describe('trading-calendar', () => {
  describe('isWeekend', () => {
    it('Saturday 2024-01-06 is weekend', () => {
      expect(isWeekend('2024-01-06')).toBe(true);
    });
    it('Sunday 2024-01-07 is weekend', () => {
      expect(isWeekend('2024-01-07')).toBe(true);
    });
    it('Monday 2024-01-08 is not weekend', () => {
      expect(isWeekend('2024-01-08')).toBe(false);
    });
  });

  describe('isHoliday', () => {
    it("New Year's Day 2024 is a holiday", () => {
      expect(isHoliday('2024-01-01')).toBe(true);
    });
    it('Juneteenth 2024 is a holiday', () => {
      expect(isHoliday('2024-06-19')).toBe(true);
    });
    it('Thanksgiving 2024 is a holiday', () => {
      expect(isHoliday('2024-11-28')).toBe(true);
    });
    it('Good Friday 2023 is a holiday', () => {
      expect(isHoliday('2023-04-07')).toBe(true);
    });
    it('an ordinary Tuesday is not a holiday', () => {
      expect(isHoliday('2024-03-12')).toBe(false);
    });
  });

  describe('isMarketOpen', () => {
    it('closed on Christmas 2024', () => {
      expect(isMarketOpen('2024-12-25')).toBe(false);
    });
    it('open on the day after Christmas 2024 (Thursday)', () => {
      expect(isMarketOpen('2024-12-26')).toBe(true);
    });
    it('closed on Sat 2024-01-06', () => {
      expect(isMarketOpen('2024-01-06')).toBe(false);
    });
    it('open on Tue 2024-01-02', () => {
      expect(isMarketOpen('2024-01-02')).toBe(true);
    });
    it('closed on 2025-01-09 (NDoM Carter)', () => {
      expect(isMarketOpen('2025-01-09')).toBe(false);
    });
  });

  describe('addDays', () => {
    it('advances forward across a month boundary', () => {
      expect(addDays('2024-01-31', 1)).toBe('2024-02-01');
    });
    it('handles negative offsets', () => {
      expect(addDays('2024-03-01', -1)).toBe('2024-02-29'); // leap day
    });
    it('handles year boundary', () => {
      expect(addDays('2024-12-31', 1)).toBe('2025-01-01');
    });
  });

  describe('nextTradingDay', () => {
    it('skips weekend', () => {
      // Friday 2024-01-05 → Monday 2024-01-08
      expect(nextTradingDay('2024-01-05')).toBe('2024-01-08');
    });
    it('skips holiday', () => {
      // 2023-12-22 Fri, 2023-12-25 Mon (Xmas), 2023-12-26 Tue
      expect(nextTradingDay('2023-12-22')).toBe('2023-12-26');
    });
    it('strictly after, even if input is itself a trading day', () => {
      expect(nextTradingDay('2024-03-12')).toBe('2024-03-13');
    });
  });

  describe('prevOrCurrentTradingDay', () => {
    it('returns same day if open', () => {
      expect(prevOrCurrentTradingDay('2024-03-12')).toBe('2024-03-12');
    });
    it('snaps back from Saturday to Friday', () => {
      expect(prevOrCurrentTradingDay('2024-01-06')).toBe('2024-01-05');
    });
    it('snaps back from holiday', () => {
      // 2024-12-25 Wed → 2024-12-24 Tue (full trading day)
      expect(prevOrCurrentTradingDay('2024-12-25')).toBe('2024-12-24');
    });
  });

  describe('tradingDaysBetween', () => {
    it('excludes weekends and holidays', () => {
      // 2024-01-01 Mon (holiday), 2024-01-02 Tue ..  2024-01-05 Fri
      // 2024-01-06,07 weekend, 2024-01-08 Mon
      const days = tradingDaysBetween('2024-01-01', '2024-01-08');
      expect(days).toEqual([
        '2024-01-02',
        '2024-01-03',
        '2024-01-04',
        '2024-01-05',
        '2024-01-08',
      ]);
    });

    it('returns empty when from > to', () => {
      expect(tradingDaysBetween('2024-03-15', '2024-03-10')).toEqual([]);
    });
  });
});
