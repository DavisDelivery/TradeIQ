// Phase 4f W4a — Dark pool ratio.
//
// Computes dark-pool-volume / total-volume per day, a 5-day rolling
// average, a 30-day baseline + stdev, and a z-score for the latest day.
//
// Off-exchange identification: Polygon's equity trade tape flags
// off-exchange reports via the trade's `x` (exchange) field OR the
// condition codes array. We use the union of both heuristics:
//   - x in {4, 6, 7} — FINRA TRF reporting venues
//   - c includes any of {12, 14, 16, 37} — ADF/TRF/dark-pool ATS print
//
// Tests construct synthetic trade arrays via `PolygonTradesByDay` so
// the compute function is fully deterministic.

import type {
  DarkPoolSignal,
  PolygonTrade,
  PolygonTradesByDay,
} from './types';

const TRF_EXCHANGES = new Set([4, 6, 7]);
const DARK_CONDITIONS = new Set([12, 14, 16, 37]);

export function isDarkTrade(t: PolygonTrade): boolean {
  if (t.x != null && TRF_EXCHANGES.has(t.x)) return true;
  if (t.c && t.c.some((code) => DARK_CONDITIONS.has(code))) return true;
  return false;
}

/**
 * Pure compute. Given a 30+-trading-day window of trades indexed by
 * date, plus the asOfDate, return a DarkPoolSignal. Returns null if
 * the window is empty or the asOfDate has no trades.
 */
export function computeDarkPoolSignal(
  ticker: string,
  asOfDate: string,
  window: PolygonTradesByDay,
): DarkPoolSignal | null {
  const dates = Object.keys(window.byDate)
    .filter((d) => d <= asOfDate)
    .sort();
  if (dates.length === 0) return null;
  const todayTrades = window.byDate[asOfDate] ?? [];
  if (todayTrades.length === 0) {
    // No trades on asOfDate (likely a non-trading day) — bail rather
    // than emit a misleading zero.
    return null;
  }

  // Per-day dark fraction.
  const dailyFrac: { date: string; frac: number }[] = [];
  for (const d of dates) {
    const trades = window.byDate[d] ?? [];
    let total = 0;
    let dark = 0;
    for (const t of trades) {
      total += t.s;
      if (isDarkTrade(t)) dark += t.s;
    }
    if (total > 0) dailyFrac.push({ date: d, frac: dark / total });
  }
  if (dailyFrac.length === 0) return null;

  const todayEntry = dailyFrac[dailyFrac.length - 1];
  if (todayEntry.date !== asOfDate) {
    // Shouldn't happen given our filter, but defensive.
    return null;
  }

  const tail = (n: number) => dailyFrac.slice(Math.max(0, dailyFrac.length - n));
  const avg = (xs: number[]) =>
    xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length;
  const stdev = (xs: number[]) => {
    if (xs.length < 2) return 0;
    const m = avg(xs);
    const v = xs.reduce((s, x) => s + (x - m) * (x - m), 0) / (xs.length - 1);
    return v > 0 ? Math.sqrt(v) : 0;
  };

  const fives = tail(5).map((d) => d.frac);
  const thirty = tail(30).map((d) => d.frac);
  // Exclude today from the baseline so the z-score measures TODAY vs
  // the prior history, not TODAY vs a window that includes itself.
  const baselineSlice = thirty.slice(0, -1);

  const darkPoolPct = todayEntry.frac;
  const darkPoolPct5dAvg = avg(fives);
  const darkPoolPct30dAvg = avg(baselineSlice.length > 0 ? baselineSlice : thirty);
  const baselineStd = stdev(baselineSlice.length > 1 ? baselineSlice : thirty);
  const zScore =
    baselineStd > 0 ? (darkPoolPct - darkPoolPct30dAvg) / baselineStd : 0;

  let todayDark = 0;
  for (const t of todayTrades) if (isDarkTrade(t)) todayDark++;

  return {
    ticker,
    asOfDate,
    darkPoolPct: +darkPoolPct.toFixed(6),
    darkPoolPct5dAvg: +darkPoolPct5dAvg.toFixed(6),
    darkPoolPct30dAvg: +darkPoolPct30dAvg.toFixed(6),
    zScore: +zScore.toFixed(4),
    todayTrades: todayTrades.length,
    todayDarkTrades: todayDark,
  };
}

// Score interpretation utility — used by Flow analyst when it
// consumes this signal. Z-score > 1.5 on a green day suggests
// accumulation; the same on a red day suggests distribution.
// `priceChangePct` is today's percent change (e.g., +0.012 for +1.2%).
export function darkPoolDirection(
  signal: DarkPoolSignal,
  priceChangePct: number,
): 'accumulation' | 'distribution' | 'neutral' {
  if (Math.abs(signal.zScore) < 1.5) return 'neutral';
  if (priceChangePct > 0 && signal.zScore > 1.5) return 'accumulation';
  if (priceChangePct < 0 && signal.zScore > 1.5) return 'distribution';
  return 'neutral';
}
