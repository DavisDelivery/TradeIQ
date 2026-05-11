import { describe, it, expect } from 'vitest';
import {
  universePoolForDate,
  windowSurvivorshipCorrected,
} from '../universe-pool';

describe('universe-pool', () => {
  describe('universePoolForDate (Dow — corrected)', () => {
    it('returns tickers inside coverage and flags corrected=true', () => {
      const r = universePoolForDate('dow', '2020-06-30');
      expect(r.tickers.length).toBeGreaterThan(0);
      expect(r.tickers).toContain('AAPL');
      expect(r.survivorshipCorrected).toBe(true);
      expect(r.snapshotDate).not.toBeNull();
      expect(r.snapshotDate! <= '2020-06-30').toBe(true);
    });

    it('returns empty + uncorrected for date before earliest snapshot', () => {
      const r = universePoolForDate('dow', '2010-01-01');
      expect(r.tickers).toEqual([]);
      expect(r.survivorshipCorrected).toBe(false);
      expect(r.snapshotDate).toBeNull();
      expect(r.coverageStart).not.toBeNull();
    });

    it('uses most-recent snapshot ≤ asOfDate (PIT semantics)', () => {
      const earlier = universePoolForDate('dow', '2018-06-15');
      const later = universePoolForDate('dow', '2018-08-15');
      // Both inside coverage; earlier uses Jun 30 (or before) snapshot,
      // later uses Aug 31 (or before).
      expect(earlier.snapshotDate! <= '2018-06-15').toBe(true);
      expect(later.snapshotDate! <= '2018-08-15').toBe(true);
    });
  });

  describe('universePoolForDate (current-seed-only universes)', () => {
    it('sp500 returns empty + uncorrected for dates BEFORE the seed snapshot', () => {
      // sp500 seed is dated 2026-05-07; before that we have no snapshot,
      // so the engine must NOT silently fall back to current — it returns
      // empty and the caller surfaces the gap.
      const r = universePoolForDate('sp500', '2024-06-01');
      expect(r.tickers).toEqual([]);
      expect(r.survivorshipCorrected).toBe(false);
      expect(r.snapshotDate).toBeNull();
    });

    it('sp500 AT or AFTER seed date returns tickers but still flags uncorrected', () => {
      const r = universePoolForDate('sp500', '2026-05-08');
      expect(r.tickers.length).toBeGreaterThan(100);
      // Single-seed universe — uncorrected by construction
      expect(r.survivorshipCorrected).toBe(false);
      expect(r.snapshotDate).toBe('2026-05-07');
    });

    it('ndx at seed date returns tickers but flags uncorrected', () => {
      // NDX seed is dated 2026-05-11
      const r = universePoolForDate('ndx', '2026-05-12');
      expect(r.tickers.length).toBeGreaterThan(50);
      expect(r.survivorshipCorrected).toBe(false);
    });
  });

  describe('windowSurvivorshipCorrected', () => {
    it('Dow window entirely inside coverage → corrected', () => {
      const result = windowSurvivorshipCorrected('dow', [
        '2020-01-31',
        '2020-06-30',
        '2020-12-31',
      ]);
      expect(result.corrected).toBe(true);
    });

    it('Dow window with any date outside coverage → not corrected', () => {
      const result = windowSurvivorshipCorrected('dow', [
        '2010-01-01', // before coverage
        '2020-06-30',
      ]);
      expect(result.corrected).toBe(false);
    });

    it('sp500 always uncorrected (current-seed only)', () => {
      const result = windowSurvivorshipCorrected('sp500', [
        '2024-01-31',
        '2024-06-30',
      ]);
      expect(result.corrected).toBe(false);
    });

    it('empty window → uncorrected', () => {
      expect(windowSurvivorshipCorrected('dow', []).corrected).toBe(false);
    });
  });
});
