// SECTOR-1 (2026-08-06) — how each sector is actually doing, and where a
// stock sits inside its own.
//
// WHY THIS EXISTS. Every ticker profile already knew its sector NAME and drew
// a stock-vs-sector relative-strength line, but it never said whether the
// sector itself was strong or weak, or how it ranked against the other ten.
// "XLK" on a page tells you nothing; "Technology, +8.4% over 3 months, #2 of
// 11, and this stock is beating it by 6 points" is context you can act on.
//
// WHAT THIS IS NOT. It is not a signal and it is not scored. Sector strength
// is DESCRIPTIVE here. The industry-momentum literature (Moskowitz &
// Grinblatt 1999) is real but contested — Grundy & Martin (2001) argued the
// effect largely reflects individual-stock momentum rather than industry
// membership — and this app has just retired six boards for shipping
// unvalidated rankings. So: numbers and rank, no composite, no "BUY the hot
// sector" verdict. If a sector-conditioned screen is ever built on top, the
// forward test measures it before anything in the UI implies an edge.
//
// One fetch serves every ticker: sector performance is identical for all
// names in a sector, so this is computed once for all 12 ETFs + SPY and
// cached, rather than recomputed per profile open.

import { SECTOR_ETFS, SPY } from './universe';
import { getDailyBars, type Bar } from './data-provider';

/** Trading-day lookbacks. 21≈1m, 63≈3m, 126≈6m, 252≈12m. */
export const LOOKBACKS = { m1: 21, m3: 63, m6: 126, m12: 252 } as const;
export type LookbackKey = keyof typeof LOOKBACKS;

export interface SectorWindow {
  /** Sector total return over the window, percent. */
  returnPct: number | null;
  /** Sector return minus SPY return over the same window, percentage points. */
  vsSpyPp: number | null;
  /** 1 = strongest of the sectors that had data for this window. */
  rank: number | null;
  /** How many sectors were rankable — the honest denominator for `rank`. */
  rankOf: number | null;
}

export interface SectorPerformance {
  sector: string;
  etf: string;
  windows: Record<LookbackKey, SectorWindow>;
  /** Share of the sector ETF's own trailing window above its 200d average. */
  aboveSma200: boolean | null;
  asOf: string | null;
}

export interface SectorPerformanceResult {
  sectors: SectorPerformance[];
  spy: Record<LookbackKey, number | null>;
  asOf: string | null;
  /** Sectors whose bars failed or were too short — named, never silently 0. */
  unavailable: string[];
}

/**
 * Percent return over the last `n` trading days of a bar series.
 *
 * Returns null rather than a partial-window number when the series is too
 * short: a "12-month return" computed from 8 months of bars is a different
 * statistic wearing the same label, and this app's whole problem has been
 * numbers that looked like what they were not.
 */
export function windowReturnPct(bars: Bar[], n: number): number | null {
  if (!Array.isArray(bars) || bars.length < n + 1) return null;
  const last = bars[bars.length - 1]?.c;
  const first = bars[bars.length - 1 - n]?.c;
  if (!Number.isFinite(last) || !Number.isFinite(first) || first === 0) return null;
  return ((last - first) / first) * 100;
}

/** Simple moving average of the final `n` closes. */
export function sma(bars: Bar[], n: number): number | null {
  if (!Array.isArray(bars) || bars.length < n) return null;
  let sum = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const c = bars[i]?.c;
    if (!Number.isFinite(c)) return null;
    sum += c;
  }
  return sum / n;
}

/**
 * Assemble the cross-sector table from already-fetched bars.
 *
 * Pure — exported so the ranking logic is unit-testable without touching a
 * provider. `barsByEtf` maps ETF symbol -> ascending daily bars.
 */
export function buildSectorPerformance(
  barsByEtf: Record<string, Bar[]>,
  spyBars: Bar[],
): SectorPerformanceResult {
  const spy: Record<LookbackKey, number | null> = {
    m1: windowReturnPct(spyBars, LOOKBACKS.m1),
    m3: windowReturnPct(spyBars, LOOKBACKS.m3),
    m6: windowReturnPct(spyBars, LOOKBACKS.m6),
    m12: windowReturnPct(spyBars, LOOKBACKS.m12),
  };

  const unavailable: string[] = [];
  const rows: SectorPerformance[] = [];

  for (const [sector, etf] of Object.entries(SECTOR_ETFS)) {
    const bars = barsByEtf[etf] ?? [];
    if (bars.length === 0) {
      unavailable.push(sector);
      continue;
    }
    const ma200 = sma(bars, 200);
    const last = bars[bars.length - 1]?.c ?? null;
    rows.push({
      sector,
      etf,
      asOf: barDate(bars[bars.length - 1]),
      aboveSma200: ma200 != null && Number.isFinite(last as number) ? (last as number) > ma200 : null,
      windows: {
        m1: emptyWindow(windowReturnPct(bars, LOOKBACKS.m1), spy.m1),
        m3: emptyWindow(windowReturnPct(bars, LOOKBACKS.m3), spy.m3),
        m6: emptyWindow(windowReturnPct(bars, LOOKBACKS.m6), spy.m6),
        m12: emptyWindow(windowReturnPct(bars, LOOKBACKS.m12), spy.m12),
      },
    });
  }

  // Rank per window, independently. A sector missing THIS window is simply
  // not ranked for it (rank stays null) and does not inflate the denominator
  // for the ones that are — so "#3 of 9" reads truthfully on a partial day.
  for (const key of Object.keys(LOOKBACKS) as LookbackKey[]) {
    const rankable = rows
      .filter((r) => r.windows[key].returnPct != null)
      .sort((a, b) => (b.windows[key].returnPct as number) - (a.windows[key].returnPct as number));
    rankable.forEach((r, i) => {
      r.windows[key].rank = i + 1;
      r.windows[key].rankOf = rankable.length;
    });
  }

  return {
    sectors: rows,
    spy,
    asOf: rows.find((r) => r.asOf)?.asOf ?? null,
    unavailable,
  };
}

function emptyWindow(returnPct: number | null, spyPct: number | null): SectorWindow {
  return {
    returnPct,
    vsSpyPp: returnPct != null && spyPct != null ? returnPct - spyPct : null,
    rank: null,
    rankOf: null,
  };
}

function barDate(bar: Bar | undefined): string | null {
  if (!bar) return null;
  const t = (bar as { t?: number; date?: string }).t;
  if (typeof t === 'number') return new Date(t).toISOString().slice(0, 10);
  const d = (bar as { date?: string }).date;
  return typeof d === 'string' ? d.slice(0, 10) : null;
}

/** In-process cache — the table is identical for every ticker in the app. */
let CACHE: { at: number; value: SectorPerformanceResult } | null = null;
const TTL_MS = 60 * 60 * 1000; // 1h; sector aggregates do not move intraday enough to matter

export function _resetSectorPerformanceCache(): void {
  CACHE = null;
}

/**
 * Fetch + compute the cross-sector table.
 *
 * A failed ETF fetch drops that sector into `unavailable` rather than failing
 * the whole call: eleven honest sectors beat zero.
 */
export async function getSectorPerformance(now = new Date()): Promise<SectorPerformanceResult> {
  if (CACHE && now.getTime() - CACHE.at < TTL_MS) return CACHE.value;

  const to = now.toISOString().slice(0, 10);
  // 420 calendar days ≈ 290 trading days — enough for a 252d window plus the
  // 200d average, with slack for holidays.
  const from = new Date(now.getTime() - 420 * 86_400_000).toISOString().slice(0, 10);

  const etfs = [...new Set(Object.values(SECTOR_ETFS))];
  const barsByEtf: Record<string, Bar[]> = {};

  const settled = await Promise.allSettled(
    etfs.map(async (etf) => [etf, await getDailyBars(etf, from, to)] as const),
  );
  for (const s of settled) {
    if (s.status === 'fulfilled') {
      const [etf, bars] = s.value;
      if (Array.isArray(bars) && bars.length > 0) barsByEtf[etf] = bars as Bar[];
    }
  }

  let spyBars: Bar[] = [];
  try {
    spyBars = ((await getDailyBars(SPY, from, to)) ?? []) as Bar[];
  } catch {
    spyBars = [];
  }

  const value = buildSectorPerformance(barsByEtf, spyBars);
  CACHE = { at: now.getTime(), value };
  return value;
}
