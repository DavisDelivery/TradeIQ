// Performance metrics: Sharpe, Sortino, MaxDD, recovery, win rate,
// profit factor, IC, IR, per-regime breakdown.
//
// All math is pure — input is a daily equity curve plus auxiliary
// arrays. Output is the PerformanceMetrics struct.
//
// Conventions:
//   - Returns are arithmetic daily returns of the equity curve
//   - Sharpe annualization factor = sqrt(252)
//   - Risk-free rate: passed in via opts (engine resolves DGS3MO at
//     endDate); defaults to 0 if not provided
//   - IC: mean Spearman rank correlation between composite and
//     forward20dReturn, averaged across rebalances

import type {
  AttributionRecord,
  DailyEquityPoint,
  MLTrainingRow,
  PerformanceMetrics,
  TradeRecord,
} from './types';
import type { Bar } from '../data-provider';

export interface MetricsInput {
  dailyEquity: DailyEquityPoint[];
  trades: TradeRecord[];
  attribution: AttributionRecord[];
  mlRows: MLTrainingRow[];
  benchmarkBars: Bar[];
  initialCapital: number;
  startDate: string;
  endDate: string;
  riskFreeAnnual?: number; // default 0
}

const TRADING_DAYS_PER_YEAR = 252;

function dailyReturns(equity: DailyEquityPoint[]): number[] {
  const rets: number[] = [];
  for (let i = 1; i < equity.length; i++) {
    const prev = equity[i - 1].value;
    if (prev > 0) rets.push((equity[i].value - prev) / prev);
  }
  return rets;
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mu = mean(xs);
  const variance = xs.reduce((s, x) => s + (x - mu) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

function maxDrawdown(
  equity: DailyEquityPoint[],
): { mdd: number; troughIdx: number; peakIdx: number } {
  let peak = equity[0]?.value ?? 0;
  let peakIdx = 0;
  let troughIdx = 0;
  let mdd = 0;
  for (let i = 0; i < equity.length; i++) {
    const v = equity[i].value;
    if (v > peak) {
      peak = v;
      peakIdx = i;
    }
    const dd = peak > 0 ? (peak - v) / peak : 0;
    if (dd > mdd) {
      mdd = dd;
      troughIdx = i;
    }
  }
  return { mdd, troughIdx, peakIdx };
}

function recoveryDays(
  equity: DailyEquityPoint[],
  troughIdx: number,
  peakBeforeDD: number,
): number | null {
  for (let i = troughIdx + 1; i < equity.length; i++) {
    if (equity[i].value >= peakBeforeDD) {
      // count trading-day distance (array index distance is a proxy)
      return i - troughIdx;
    }
  }
  return null;
}

/**
 * Spearman rank correlation. Returns NaN-safe 0 when stddev is zero.
 */
export function spearman(xs: number[], ys: number[]): number {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  const xRanks = ranksOf(xs);
  const yRanks = ranksOf(ys);
  const mx = mean(xRanks);
  const my = mean(yRanks);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < xRanks.length; i++) {
    num += (xRanks[i] - mx) * (yRanks[i] - my);
    dx += (xRanks[i] - mx) ** 2;
    dy += (yRanks[i] - my) ** 2;
  }
  const denom = Math.sqrt(dx * dy);
  return denom > 0 ? num / denom : 0;
}

function ranksOf(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array<number>(xs.length);
  // Handle ties with average rank
  let i = 0;
  while (i < indexed.length) {
    let j = i;
    while (j + 1 < indexed.length && indexed[j + 1].v === indexed[i].v) j++;
    const avgRank = (i + j) / 2 + 1; // 1-indexed
    for (let k = i; k <= j; k++) ranks[indexed[k].i] = avgRank;
    i = j + 1;
  }
  return ranks;
}

export function computeMetrics(input: MetricsInput): PerformanceMetrics {
  const rfAnnual = input.riskFreeAnnual ?? 0;
  const rfDaily = rfAnnual / TRADING_DAYS_PER_YEAR;

  const equity = input.dailyEquity;
  if (equity.length < 2) {
    return emptyMetrics();
  }

  const finalValue = equity[equity.length - 1].value;
  const totalReturn = (finalValue - input.initialCapital) / input.initialCapital;

  // CAGR — approximate years by trading days / 252
  const tradingDays = equity.length - 1;
  const years = tradingDays / TRADING_DAYS_PER_YEAR;
  const cagr =
    years > 0 && finalValue > 0
      ? Math.pow(finalValue / input.initialCapital, 1 / years) - 1
      : 0;

  const rets = dailyReturns(equity);
  const excessRets = rets.map((r) => r - rfDaily);
  const sharpe =
    stddev(excessRets) > 0
      ? (mean(excessRets) / stddev(excessRets)) * Math.sqrt(TRADING_DAYS_PER_YEAR)
      : 0;

  // Sortino — downside deviation per the standard definition:
  // sqrt( Σ min(r, 0)² / N ) over ALL excess returns (zero-floored), NOT
  // an RMS over only the negative returns with n−1 (which overstated
  // downside risk and understated Sortino — code-review-2026-06 track-3
  // minor 1).
  const downsideStd =
    excessRets.length > 0
      ? Math.sqrt(
          excessRets.reduce((s, r) => s + Math.min(r, 0) ** 2, 0) /
            excessRets.length,
        )
      : 0;
  const sortino =
    downsideStd > 0
      ? (mean(excessRets) / downsideStd) * Math.sqrt(TRADING_DAYS_PER_YEAR)
      : 0;

  // Max drawdown + recovery
  const { mdd, troughIdx, peakIdx } = maxDrawdown(equity);
  const peakBeforeDD = equity[peakIdx]?.value ?? finalValue;
  const recovery = mdd > 0 ? recoveryDays(equity, troughIdx, peakBeforeDD) : 0;

  // Win/loss stats on attribution segment returns
  const segmentReturns = input.attribution.map((a) => a.segmentReturn);
  const wins = segmentReturns.filter((r) => r > 0);
  const losses = segmentReturns.filter((r) => r < 0);
  const winRate =
    segmentReturns.length > 0 ? (wins.length / segmentReturns.length) * 100 : 0;
  const avgWin = wins.length > 0 ? mean(wins) * 100 : 0;
  const avgLoss = losses.length > 0 ? mean(losses) * 100 : 0;
  const grossWin = wins.reduce((s, w) => s + w, 0);
  const grossLoss = Math.abs(losses.reduce((s, l) => s + l, 0));
  const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

  // Information Coefficient — Spearman(composite, forward20d) per
  // rebalance, then averaged
  const ic = computeInformationCoefficient(input.mlRows);

  // Information Ratio — (portfolio return - benchmark return) / tracking error
  const ir = computeInformationRatio(equity, input.benchmarkBars, rfDaily);

  // Per-regime breakdown
  const perRegime = computePerRegime(input.attribution, equity);

  return {
    totalReturnPct: +(totalReturn * 100).toFixed(4),
    cagrPct: +(cagr * 100).toFixed(4),
    sharpe: +sharpe.toFixed(4),
    sortino: +sortino.toFixed(4),
    maxDrawdownPct: +(mdd * 100).toFixed(4),
    recoveryDays: recovery,
    winRatePct: +winRate.toFixed(2),
    avgWinPct: +avgWin.toFixed(4),
    avgLossPct: +avgLoss.toFixed(4),
    profitFactor: Number.isFinite(profitFactor)
      ? +profitFactor.toFixed(4)
      : profitFactor,
    informationCoefficient: +ic.toFixed(4),
    informationRatio: +ir.toFixed(4),
    tradeCount: input.trades.length,
    rebalanceCount: new Set(input.trades.map((t) => t.rebalanceDate)).size,
    perRegime,
  };
}

function computeInformationCoefficient(rows: MLTrainingRow[]): number {
  // Group by asOfDate (rebalance), compute Spearman per group, average
  const byDate = new Map<string, MLTrainingRow[]>();
  for (const r of rows) {
    if (r.forward20dReturn == null) continue;
    const arr = byDate.get(r.asOfDate) ?? [];
    arr.push(r);
    byDate.set(r.asOfDate, arr);
  }
  const ics: number[] = [];
  for (const [, group] of byDate) {
    if (group.length < 3) continue;
    const composites = group.map((r) => r.composite);
    const forwards = group.map((r) => r.forward20dReturn ?? 0);
    ics.push(spearman(composites, forwards));
  }
  return ics.length > 0 ? mean(ics) : 0;
}

function computeInformationRatio(
  equity: DailyEquityPoint[],
  benchBars: Bar[],
  rfDaily: number,
): number {
  if (benchBars.length < 2 || equity.length < 2) return 0;
  // Align by date
  const benchByDate = new Map<string, number>();
  for (const b of benchBars) {
    const d = new Date(b.t as unknown as number).toISOString().slice(0, 10);
    benchByDate.set(d, b.c);
  }
  const aligned: { port: number; bench: number }[] = [];
  let prevPort: number | null = null;
  let prevBench: number | null = null;
  for (const eq of equity) {
    const benchC = benchByDate.get(eq.date);
    if (benchC === undefined) continue;
    if (prevPort != null && prevBench != null) {
      aligned.push({
        port: (eq.value - prevPort) / prevPort,
        bench: (benchC - prevBench) / prevBench,
      });
    }
    prevPort = eq.value;
    prevBench = benchC;
  }
  if (aligned.length < 2) return 0;
  const diffs = aligned.map((a) => a.port - a.bench);
  const trackingErr = stddev(diffs);
  return trackingErr > 0
    ? (mean(diffs) / trackingErr) * Math.sqrt(TRADING_DAYS_PER_YEAR)
    : 0;
}

function computePerRegime(
  attribution: AttributionRecord[],
  equity: DailyEquityPoint[],
): PerformanceMetrics['perRegime'] {
  const out: PerformanceMetrics['perRegime'] = {};
  const byRegime = new Map<string, AttributionRecord[]>();
  for (const a of attribution) {
    const r = a.regime ?? 'unknown';
    const arr = byRegime.get(r) ?? [];
    arr.push(a);
    byRegime.set(r, arr);
  }
  // For each regime, compute approximate metrics from segment returns.
  // We don't have per-day equity tagged by regime, so we use the
  // attribution-implied contributions: sum of weighted segment returns.
  //
  // code-review-2026-06 track-3 minor 2 — this used to be exposed as a
  // per-regime "sharpe": mean/std of CROSS-SECTIONAL per-position segment
  // returns annualized with √(252/20), which mixes cross-sectional
  // dispersion with time-series vol and is statistically meaningless. We
  // don't redesign here; we report the honest quantity we actually have:
  // the average ~20-trading-day per-position segment return (percent,
  // un-annualized), as `avgSegmentReturnPct`.
  for (const [regime, recs] of byRegime) {
    const seg = recs.map((r) => r.contribution);
    const segReturns = recs.map((r) => r.segmentReturn);
    if (seg.length === 0) {
      out[regime] = { avgSegmentReturnPct: 0, totalReturnPct: 0, rebalanceCount: 0 };
      continue;
    }
    const totalRet = seg.reduce((s, x) => s + x, 0);
    out[regime] = {
      avgSegmentReturnPct: +(mean(segReturns) * 100).toFixed(4),
      totalReturnPct: +(totalRet * 100).toFixed(4),
      rebalanceCount: new Set(recs.map((r) => r.rebalanceDate)).size,
    };
  }
  return out;
}

function emptyMetrics(): PerformanceMetrics {
  return {
    totalReturnPct: 0,
    cagrPct: 0,
    sharpe: 0,
    sortino: 0,
    maxDrawdownPct: 0,
    recoveryDays: null,
    winRatePct: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    profitFactor: 0,
    informationCoefficient: 0,
    informationRatio: 0,
    tradeCount: 0,
    rebalanceCount: 0,
    perRegime: {},
  };
}
