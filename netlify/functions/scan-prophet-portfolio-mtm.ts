// Phase 4e-1 / Wave 3A (CR-5, M9) — Daily mark-to-market for the
// Prophet largecap portfolio.
//
// Cadence: weekdays at 22:00 UTC — after the 4pm-ET close in both EST
// and EDT and after EOD aggregates settle (the old 21:00 slot was
// exactly 16:00 ET in winter, before settlement). An isMarketClosed
// guard skips NYSE holidays, mirroring the prophet cron dispatchers
// (shared/prophet-cron-dispatcher.ts).
//
// VALUATION (CR-5): positions are NOT valued as persisted shares ×
// today's close. Polygon closes are split-adjusted (adjusted=true), so
// a fixed entry-time share count read against today's adjusted close
// misreads every split as a price move (a 2:1 split = instant −50%
// "equity"), and the corrupted state gets re-persisted. Instead each
// position's `marketValue` is CHAINED: compounded daily by
// todayAdjClose/baseAdjClose with BOTH closes taken from the same bar
// fetch. Adjusted closes are split-consistent within a fetch, so the
// ratio is the true economic price return regardless of splits.
// `shares`/`entryPrice`/`currentPrice` remain as cosmetic entry-time /
// display records only (see types.ts).
//
// DIVIDENDS: Polygon adjusted=true is splits-only — dividends are never
// credited. The portfolio AND the SPY/QQQ/IWF benchmark columns are
// therefore both PRICE-ONLY return series, consistent on both sides of
// every comparison. Dividend ingestion is explicitly out of scope here.
//
// EQUITY-CURVE DATES (M9): each point is keyed by the BAR's own date
// (the latest settled session, from SPY's bar timestamp), never the
// wall-clock date the cron ran. If a point for that bar date already
// exists the run is a no-op — holidays/duplicate invocations can never
// write flat duplicate points.
//
// MIGRATION: state persisted before Wave 3A has no per-position
// lastMarkDate. recomputeMarks seeds the chain for such positions from
// the legacy shares×price marketValue as of state.asOfDate. Historical
// equity-curve points are NOT retroactively repaired.
//
// Pre-W5 this function observes `state===null` and exits early; that is
// the expected path until the rebalance scheduler ships.

import { schedule } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { logger } from './shared/logger';
import { isMarketClosed } from './shared/us-market-holidays';
import {
  appendEquityCurvePoint,
  getEquityCurvePoint,
  getPortfolioState,
  writePortfolioState,
} from './shared/prophet-portfolio/state';
import type {
  EquityCurvePoint,
  PortfolioPosition,
  PortfolioState,
  PortfolioUniverse,
} from './shared/prophet-portfolio/types';

const UNIVERSE = 'largecap' as const;
export const CRON = '0 22 * * 1-5';

/** How far past the oldest chain base we fetch, to bridge weekends,
 *  holidays, and short cron outages in a single split-consistent fetch. */
const FETCH_BUFFER_DAYS = 7;
/** Floor for the fetch window when the state is fresh (benchmarks etc.). */
const MIN_FETCH_DAYS = 14;

export interface MarkBar {
  date: string; // YYYY-MM-DD (bar's own session date, UTC)
  close: number; // adjusted close — split-consistent WITHIN one fetch
}

export interface BenchmarkBars {
  spy: MarkBar[];
  qqq: MarkBar[];
  iwf: MarkBar[];
}

function latestClose(bars: MarkBar[]): number | null {
  const last = bars[bars.length - 1];
  return last && Number.isFinite(last.close) ? last.close : null;
}

/** Base date a position's chain resumes from. Pre-Wave-3A rows have no
 *  lastMarkDate — their persisted marketValue (= legacy shares×price)
 *  was marked as of state.asOfDate, so the chain seeds from there. */
function chainBaseDate(p: PortfolioPosition, state: PortfolioState): string {
  if (p.lastMarkDate) return p.lastMarkDate;
  const fallback = state.asOfDate || p.entryDate;
  // A position entered after the state's asOfDate chains from entry.
  return p.entryDate > fallback ? p.entryDate : fallback;
}

/** Earliest date the handler must fetch bars from to resume every
 *  position's chain (exported for the handler + tests). */
export function earliestFetchDate(state: PortfolioState, today: string): string {
  let earliest = today;
  for (const p of state.positions) {
    const base = chainBaseDate(p, state);
    if (base < earliest) earliest = base;
  }
  const floorMs = Date.parse(`${today}T00:00:00Z`) - MIN_FETCH_DAYS * 86_400_000;
  const baseMs = Date.parse(`${earliest}T00:00:00Z`) - FETCH_BUFFER_DAYS * 86_400_000;
  return new Date(Math.min(floorMs, baseMs)).toISOString().slice(0, 10);
}

/**
 * Pure helper extracted for unit testing: chain every position's value
 * forward from its last marked bar to the latest bar in `bars`, derive
 * the curve-point date from the bars themselves, and return the new
 * state + equity curve point. Returns null when no bar series offers a
 * new session to mark (nothing to write).
 */
export function recomputeMarks(
  state: PortfolioState,
  bars: Map<string, MarkBar[]>,
  benchmarks: BenchmarkBars,
  nowIso: string,
): { newState: PortfolioState; curvePoint: EquityCurvePoint; warnings: string[] } | null {
  const warnings: string[] = [];

  // M9 — the point's date comes from the BARS, not the wall clock:
  // SPY's latest bar is the canonical settled session; fall back to the
  // latest position bar if the SPY fetch failed.
  let barDate: string | null = null;
  const allSeries = [benchmarks.spy, ...state.positions.map((p) => bars.get(p.ticker) ?? [])];
  for (const series of allSeries) {
    const last = series[series.length - 1];
    if (last && (barDate === null || last.date > barDate)) barDate = last.date;
  }
  if (barDate === null) return null; // no bars anywhere — nothing to mark

  const newPositions: PortfolioPosition[] = state.positions.map((p) => {
    const series = bars.get(p.ticker) ?? [];
    // Migration-tolerant seed: chained value if present, else the legacy
    // shares×price mark (old-shape rows persisted exactly that).
    const seedValue =
      Number.isFinite(p.marketValue) && p.marketValue > 0
        ? p.marketValue
        : p.shares * p.currentPrice;
    const baseDate = chainBaseDate(p, state);

    // Base bar: latest bar at-or-before the chain base. Both the base
    // and the latest bar come from THIS fetch → same adjusted basis →
    // the ratio is split-safe (CR-5).
    let baseIdx = -1;
    for (let i = series.length - 1; i >= 0; i--) {
      if (series[i].date <= baseDate) {
        baseIdx = i;
        break;
      }
    }
    if (baseIdx < 0) {
      warnings.push(`${p.ticker}: no bar at-or-before ${baseDate} — value held stale`);
      return { ...p, marketValue: seedValue, weight: 0 };
    }
    const base = series[baseIdx];
    const last = series[series.length - 1];
    if (last.date <= baseDate || !(base.close > 0)) {
      // No new session for this ticker (halted/no fresh bar) — hold the
      // chained value; lastMarkDate normalizes to the actual bar date.
      return { ...p, marketValue: seedValue, weight: 0, lastMarkDate: base.date };
    }
    const ret = last.close / base.close; // split-safe daily/compound return
    return {
      ...p,
      currentPrice: last.close, // display only
      marketValue: seedValue * ret,
      weight: 0,
      lastMarkDate: last.date,
    };
  });

  const holdingsValue = newPositions.reduce((s, p) => s + p.marketValue, 0);
  const equity = state.cash + holdingsValue;
  for (const p of newPositions) {
    p.weight = equity > 0 ? p.marketValue / equity : 0;
  }
  // Return since the previous written point (price-only on both the
  // portfolio and benchmark sides — see header).
  const dailyReturn =
    state.equity > 0 ? (equity - state.equity) / state.equity : 0;

  return {
    newState: {
      ...state,
      asOfDate: barDate,
      positions: newPositions,
      equity,
      updatedAt: nowIso,
    },
    curvePoint: {
      date: barDate,
      equity,
      cash: state.cash,
      holdingsValue,
      dailyReturn,
      spyClose: latestClose(benchmarks.spy),
      qqqClose: latestClose(benchmarks.qqq),
      iwfClose: latestClose(benchmarks.iwf),
    },
    warnings,
  };
}

// --- handler body (dependency-injected for tests, mirroring the seam in
// shared/prophet-cron-dispatcher.ts) ----------------------------------------

export interface MtmDeps {
  now: () => Date;
  marketClosed: (d: Date) => boolean;
  getState: (u: PortfolioUniverse) => Promise<PortfolioState | null>;
  writeState: (u: PortfolioUniverse, s: PortfolioState) => Promise<void>;
  getCurvePoint: (u: PortfolioUniverse, date: string) => Promise<EquityCurvePoint | null>;
  appendCurvePoint: (u: PortfolioUniverse, p: EquityCurvePoint) => Promise<void>;
  fetchBars: (ticker: string, from: string, to: string) => Promise<MarkBar[]>;
}

async function defaultFetchBars(
  ticker: string,
  from: string,
  to: string,
): Promise<MarkBar[]> {
  try {
    const raw = await getDailyBars(ticker, from, to);
    return raw
      .filter((b) => typeof b.t === 'number' && typeof b.c === 'number')
      .map((b) => ({
        date: new Date(b.t).toISOString().slice(0, 10),
        close: b.c,
      }));
  } catch {
    return [];
  }
}

const defaultDeps: MtmDeps = {
  now: () => new Date(),
  marketClosed: isMarketClosed,
  getState: getPortfolioState,
  writeState: writePortfolioState,
  getCurvePoint: getEquityCurvePoint,
  appendCurvePoint: appendEquityCurvePoint,
  fetchBars: defaultFetchBars,
};

export async function runMtm(deps: MtmDeps = defaultDeps) {
  const log = logger.child({ fn: 'scan-prophet-portfolio-mtm', universe: UNIVERSE });
  try {
    const now = deps.now();
    const today = now.toISOString().slice(0, 10);

    // M9 — holiday/weekend guard (same discipline as the prophet cron
    // dispatchers): a closed market has no new session to mark.
    if (deps.marketClosed(now)) {
      log.info('mtm_skipped_market_closed', { date: today });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, action: 'skipped-market-closed', date: today }),
      };
    }

    const state = await deps.getState(UNIVERSE);
    if (!state) {
      log.info('mtm_no_state', { universe: UNIVERSE });
      return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'no-state' }) };
    }
    const nowIso = now.toISOString();
    const fromDate = earliestFetchDate(state, today);

    const tickers = state.positions.map((p) => p.ticker);
    const [positionEntries, spy, qqq, iwf] = await Promise.all([
      Promise.all(
        tickers.map(async (t) => [t, await deps.fetchBars(t, fromDate, today)] as const),
      ),
      deps.fetchBars('SPY', fromDate, today),
      deps.fetchBars('QQQ', fromDate, today),
      deps.fetchBars('IWF', fromDate, today),
    ]);
    const bars = new Map<string, MarkBar[]>(positionEntries);

    const result = recomputeMarks(state, bars, { spy, qqq, iwf }, nowIso);
    if (!result) {
      log.warn('mtm_no_bars', { universe: UNIVERSE, fromDate, today });
      return { statusCode: 200, body: JSON.stringify({ ok: true, action: 'no-bars' }) };
    }
    const { newState, curvePoint, warnings } = result;

    // M9 — duplicate-bar-date guard: if the latest settled bar already
    // has a point, this run has nothing new (post-holiday morning runs,
    // double invocations) — write neither state nor a flat point.
    const existing = await deps.getCurvePoint(UNIVERSE, curvePoint.date);
    if (existing) {
      log.info('mtm_skipped_duplicate_bar_date', {
        universe: UNIVERSE,
        barDate: curvePoint.date,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({
          ok: true,
          action: 'skipped-duplicate-bar-date',
          barDate: curvePoint.date,
        }),
      };
    }

    await deps.writeState(UNIVERSE, newState);
    await deps.appendCurvePoint(UNIVERSE, curvePoint);

    log.info('mtm_complete', {
      universe: UNIVERSE,
      barDate: curvePoint.date,
      equity: newState.equity,
      positions: newState.positions.length,
      dailyReturn: curvePoint.dailyReturn,
      warnings,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        barDate: curvePoint.date,
        equity: newState.equity,
        warnings,
      }),
    };
  } catch (err: any) {
    log.error('mtm_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
}

export const handler = schedule(CRON, async () => runMtm());
