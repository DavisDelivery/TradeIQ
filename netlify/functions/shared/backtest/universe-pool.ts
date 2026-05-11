// Resolve "what tickers were in this universe on date X" for the backtest.
//
// Wraps Phase 3's UNIVERSE_HISTORY + tickersInIndexOnDate with two
// affordances the engine needs:
//   1. A `survivorshipCorrected` flag per call — true when asOfDate falls
//      inside the snapshot coverage window, false when we had to fall back
//      to the earliest-known seed (or no coverage at all).
//   2. Defensive error surfacing when no snapshot covers the date — we
//      DO NOT silently fall back to "current constituents." The engine
//      surfaces the error and Phase 4b UI gates the run.

import {
  tickersInIndexOnDate,
  universeHistoryCoverage,
  UNIVERSE_HISTORY,
} from '../universe-history';
import type { BacktestUniverse } from './types';

export interface UniversePoolResult {
  tickers: string[];
  /**
   * True iff asOfDate falls within snapshot coverage (i.e., the universe
   * is point-in-time accurate, not survivorship-biased).
   */
  survivorshipCorrected: boolean;
  /** The snapshot date used (most recent ≤ asOfDate). Null if no coverage. */
  snapshotDate: string | null;
  /** The earliest snapshot we have for this universe. */
  coverageStart: string | null;
  /** The latest snapshot we have for this universe. */
  coverageEnd: string | null;
}

/**
 * For each universe, the date BEFORE which our snapshot coverage means
 * survivorship-corrected, and AFTER which we don't have data. For
 * sp500/ndx/russell2k where coverage is current-seed-only, the start
 * date is also the end date — every backtest date is uncorrected even
 * if technically inside coverage.
 */
function isInsideCoverage(
  universe: BacktestUniverse,
  asOfDate: string,
  coverage: ReturnType<typeof universeHistoryCoverage>,
): boolean {
  const c = coverage[universe];
  if (!c.firstDate || !c.lastDate) return false;
  if (asOfDate < c.firstDate || asOfDate > c.lastDate) return false;
  // Coverage exists for this date. But "current-seed-only" universes
  // (where firstDate === lastDate) are uncorrected by construction —
  // they're a single snapshot reflecting "now." Treat as uncorrected.
  if (c.snapshotCount <= 1) return false;
  return true;
}

export function universePoolForDate(
  universe: BacktestUniverse,
  asOfDate: string,
): UniversePoolResult {
  const tickers = tickersInIndexOnDate(universe, asOfDate);
  const coverage = universeHistoryCoverage();
  const cov = coverage[universe];

  // tickersInIndexOnDate returns null if no snapshot is ≤ asOfDate.
  // That's a real data gap — refuse to silently substitute current.
  if (tickers === null) {
    return {
      tickers: [],
      survivorshipCorrected: false,
      snapshotDate: null,
      coverageStart: cov.firstDate,
      coverageEnd: cov.lastDate,
    };
  }

  const snapshotDate = findSnapshotDateForDate(universe, asOfDate);
  return {
    tickers,
    survivorshipCorrected: isInsideCoverage(universe, asOfDate, coverage),
    snapshotDate,
    coverageStart: cov.firstDate,
    coverageEnd: cov.lastDate,
  };
}

function findSnapshotDateForDate(
  universe: BacktestUniverse,
  asOfDate: string,
): string | null {
  const candidate = UNIVERSE_HISTORY
    .filter((s) => s.index === universe && s.date <= asOfDate)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return candidate?.date ?? null;
}

/**
 * Aggregate verdict over a full backtest window: was every rebalance date
 * survivorship-corrected? Used by the engine to stamp the BacktestResult.
 *
 * Strict: returns true only if every rebalance date fell inside coverage.
 * Even one date outside ⇒ false.
 */
export function windowSurvivorshipCorrected(
  universe: BacktestUniverse,
  rebalanceDates: string[],
): { corrected: boolean; coverageThrough: string | null } {
  const coverage = universeHistoryCoverage();
  const cov = coverage[universe];
  if (rebalanceDates.length === 0 || !cov.firstDate || !cov.lastDate) {
    return { corrected: false, coverageThrough: cov.firstDate };
  }
  if (cov.snapshotCount <= 1) {
    // Current-seed-only universe — uncorrected by construction.
    return { corrected: false, coverageThrough: cov.firstDate };
  }
  const allInside = rebalanceDates.every((d) => isInsideCoverage(universe, d, coverage));
  return {
    corrected: allInside,
    coverageThrough: cov.firstDate,
  };
}
