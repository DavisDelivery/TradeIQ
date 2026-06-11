import { describe, it, expect } from 'vitest';
import {
  universePoolForDate,
  windowSurvivorshipCorrected,
} from '../universe-pool';
import { universeHistoryCoverage } from '../../universe-history';

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

  describe('universePoolForDate (sp500 — corrected via Phase 0a-2 IVV backfill)', () => {
    it('sp500 returns empty + uncorrected for dates BEFORE the earliest IVV snapshot', () => {
      // sp500 IVV backfill starts 2018-01-31; before that we have no
      // snapshot, so the engine must NOT silently fall back to current —
      // it returns empty and the caller surfaces the gap.
      const r = universePoolForDate('sp500', '2017-06-30');
      expect(r.tickers).toEqual([]);
      expect(r.survivorshipCorrected).toBe(false);
      expect(r.snapshotDate).toBeNull();
    });

    it('sp500 inside coverage returns tickers and flags corrected=true', () => {
      const r = universePoolForDate('sp500', '2020-06-30');
      expect(r.tickers.length).toBeGreaterThan(400);
      expect(r.survivorshipCorrected).toBe(true);
      expect(r.snapshotDate).not.toBeNull();
      expect(r.snapshotDate! <= '2020-06-30').toBe(true);
    });

    it('sp500 walks back to the most-recent snapshot ≤ asOfDate (PIT semantics)', () => {
      const earlier = universePoolForDate('sp500', '2018-06-15');
      const later = universePoolForDate('sp500', '2018-08-15');
      expect(earlier.snapshotDate! <= '2018-06-15').toBe(true);
      expect(later.snapshotDate! <= '2018-08-15').toBe(true);
      expect(earlier.snapshotDate).not.toBe(later.snapshotDate);
    });
  });

  describe('universePoolForDate (ndx — still current-seed-only)', () => {
    it('ndx at the seed date returns tickers but flags uncorrected', () => {
      // The NDX seed is auto-dated to "today" by the generator (Invesco
      // QQQ feed remains blocked); pin to the actual seed date to keep
      // this assertion robust across regenerations.
      const coverage = universeHistoryCoverage();
      const seedDate = coverage.ndx.firstDate!;
      expect(seedDate).not.toBeNull();
      const r = universePoolForDate('ndx', seedDate);
      expect(r.tickers.length).toBeGreaterThan(50);
      expect(r.survivorshipCorrected).toBe(false);
    });
  });

  describe('universePoolForDate — no duplicate tickers (M5)', () => {
    it('previously-affected snapshot dates produce duplicate-free pools', () => {
      // These (universe, date) pairs resolved to snapshots that carried
      // literal duplicates ("ADRO","ADRO"; "JPM","JPM"; …) before the
      // 2026-06 data fix. The pool must be duplicate-free for all of
      // them — both via the corrected data and the defensive dedupe.
      const cases: Array<['sp500' | 'russell2k', string]> = [
        ['russell2k', '2025-10-31'],
        ['russell2k', '2025-06-30'],
        ['russell2k', '2024-05-31'],
        ['russell2k', '2022-12-31'],
        ['russell2k', '2022-03-31'],
        ['sp500', '2025-09-30'],
      ];
      for (const [universe, date] of cases) {
        const r = universePoolForDate(universe, date);
        expect(r.tickers.length).toBeGreaterThan(0);
        expect(
          new Set(r.tickers).size,
          `${universe} ${date} pool has duplicates`,
        ).toBe(r.tickers.length);
      }
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

    it('sp500 window entirely inside IVV coverage → corrected (Phase 0a-2)', () => {
      const result = windowSurvivorshipCorrected('sp500', [
        '2024-01-31',
        '2024-06-30',
      ]);
      expect(result.corrected).toBe(true);
    });

    it('sp500 window with a pre-IVV-coverage date → not corrected', () => {
      const result = windowSurvivorshipCorrected('sp500', [
        '2010-01-01', // before earliest IVV snapshot
        '2024-06-30',
      ]);
      expect(result.corrected).toBe(false);
    });

    it('empty window → uncorrected', () => {
      expect(windowSurvivorshipCorrected('dow', []).corrected).toBe(false);
    });
  });
});
