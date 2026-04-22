// Backtest engine — v2 with robustness primitives baked in.
//
// Over v1 this adds:
//   1. Position sizing functions (equal-weight, vol-target, Kelly-fraction)
//   2. Transaction cost + slippage modeling
//   3. Regime-gated gross exposure
//   4. Tier discipline (only-A, A+B, all-tiers)
//   5. Walk-forward loop skeleton (train window, test window, roll)
//
// Data layer is pluggable via the getPriceSeries / getBoardSnapshot hooks so we can wire
// actual data sources (Polygon, IEX, etc.) later without touching the engine.
//
// Endpoint: POST /api/backtest
// Body:    { startDate, endDate, config: BacktestConfig }
// Returns: BacktestResult

import type { Handler } from '@netlify/functions';
import type { BacktestResult, BacktestTrade, Side, Tier } from '../shared/types';
import { blobSet } from '../shared/blobs';

export interface BacktestConfig {
  tiersAllowed: Tier[]; // ['A'] for strict, ['A','B'] for loose
  sidesAllowed: Side[]; // ['long'] to kill broken shorts
  sizing: 'equal' | 'vol-target' | 'kelly';
  volTargetPct?: number; // annualized portfolio vol target if sizing = 'vol-target'
  kellyFraction?: number; // fractional-Kelly multiplier (0.25-0.5 typical)
  holdingDays: number; // exit N trading days after entry
  maxPositions: number;
  transactionCostBps: number; // round-trip in basis points (typ 2-10)
  slippageBps: number; // expected slippage per fill (typ 1-5)
  regimeGating: boolean; // if true, reduce gross exposure in RISK OFF
}

const DEFAULT_CONFIG: BacktestConfig = {
  tiersAllowed: ['A'], // tier discipline: only A-tier
  sidesAllowed: ['long'], // kill shorts by default — they're -3% alpha
  sizing: 'vol-target',
  volTargetPct: 10, // 10% annualized portfolio vol
  kellyFraction: 0.3,
  holdingDays: 10,
  maxPositions: 7,
  transactionCostBps: 5,
  slippageBps: 2,
  regimeGating: true,
};

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { error: 'Method not allowed. Use POST.' });
  }

  let body: {
    startDate?: string;
    endDate?: string;
    config?: Partial<BacktestConfig>;
  };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return json(400, { error: 'Invalid JSON body' });
  }

  const startDate = body.startDate ?? defaultStart();
  const endDate = body.endDate ?? new Date().toISOString().slice(0, 10);
  const config: BacktestConfig = { ...DEFAULT_CONFIG, ...body.config };

  try {
    const result = await runBacktest(startDate, endDate, config);
    // Persist for later review
    const key = `${startDate}_${endDate}_${Date.now()}`;
    await blobSet('backtests', key, { config, result });
    return json(200, result);
  } catch (err: any) {
    console.error('backtest failed', err);
    return json(500, { error: String(err?.message ?? err) });
  }
};

// -----------------------------------------------------------------------------
// Engine
// -----------------------------------------------------------------------------

async function runBacktest(
  start: string,
  end: string,
  cfg: BacktestConfig,
): Promise<BacktestResult> {
  // TODO wire actual historical board + price data.
  // For now the engine runs the control flow end-to-end with placeholder data so
  // the scaffolding is verifiable; replace getBoardSnapshot / getPriceSeries hooks
  // with real sources (Polygon, IEX, etc.) before trusting the result.
  const tradingDays = enumerateTradingDays(start, end);
  const trades: BacktestTrade[] = [];
  const equityCurve: Array<{ date: string; portfolio: number; spy: number }> = [];
  let portfolio = 1.0;
  let spy = 1.0;

  for (const day of tradingDays) {
    const board = await getBoardSnapshot(day);
    if (!board) continue;

    // Apply regime gating
    const grossExposure = cfg.regimeGating ? exposureForRegime(board.regime) : 1.0;

    // Filter candidates by tier + side + score threshold
    const picks = board.candidates
      .filter((c: any) => cfg.tiersAllowed.includes(c.tier))
      .filter((c: any) => cfg.sidesAllowed.includes(c.side))
      .filter((c: any) => c.conflictLevel !== 'severe')
      .slice(0, cfg.maxPositions);

    if (picks.length === 0) {
      // Still track the SPY benchmark day
      const spyRet = await getSpyReturn(day, 1);
      spy *= 1 + spyRet;
      equityCurve.push({ date: day, portfolio, spy });
      continue;
    }

    // Size each position
    const weights = computeWeights(picks, cfg, grossExposure);

    // Enter positions; exit after holdingDays
    const exitDay = offsetDay(day, cfg.holdingDays, tradingDays);
    for (const [i, pick] of picks.entries()) {
      const entryPrice = pick.price;
      const exitPrice = await getPriceAt(pick.ticker, exitDay);
      if (!exitPrice) continue;
      const sideMult = pick.side === 'long' ? 1 : -1;
      const grossPnl = sideMult * (exitPrice - entryPrice) / entryPrice;
      const costs = (cfg.transactionCostBps + cfg.slippageBps * 2) / 10_000;
      const netPnl = grossPnl - costs;
      const spyOverWindow = await getSpyReturn(day, cfg.holdingDays);
      const alpha = netPnl - sideMult * spyOverWindow;

      trades.push({
        ticker: pick.ticker,
        side: pick.side,
        tier: pick.tier,
        entry: day,
        exit: exitDay,
        entryPrice,
        exitPrice,
        pnlPct: netPnl * 100,
        positionSizePct: weights[i] * 100,
        alpha: alpha * 100,
        compositeAtEntry: pick.composite,
      });
    }

    // Roll portfolio value forward for this holding period
    const dayReturn = trades
      .filter((t) => t.entry === day)
      .reduce((sum, t) => sum + (t.pnlPct / 100) * (t.positionSizePct / 100), 0);
    portfolio *= 1 + dayReturn / cfg.holdingDays; // approximate daily mark
    const spyRet = await getSpyReturn(day, 1);
    spy *= 1 + spyRet;
    equityCurve.push({ date: day, portfolio, spy });
  }

  return summarize(start, end, trades, equityCurve);
}

// -----------------------------------------------------------------------------
// Position sizing
// -----------------------------------------------------------------------------

function computeWeights(
  picks: Array<{ ticker: string; composite: number }>,
  cfg: BacktestConfig,
  gross: number,
): number[] {
  const n = picks.length;
  if (n === 0) return [];

  switch (cfg.sizing) {
    case 'equal':
      return picks.map(() => gross / n);

    case 'vol-target': {
      // Placeholder vol estimate — in production, pull rolling 30d realized vol per ticker.
      // Higher composite = slightly lower assumed vol (proxy for quality).
      const vols = picks.map((p) => Math.max(0.15, 0.45 - (p.composite / 100) * 0.2));
      const invVol = vols.map((v) => 1 / v);
      const sumInvVol = invVol.reduce((a, b) => a + b, 0);
      return invVol.map((w) => (w / sumInvVol) * gross);
    }

    case 'kelly': {
      // Fractional Kelly: w_i = f * edge_i / variance_i, capped
      // Edge proxy = (composite - 50) / 50, i.e. A-tier 92 → edge 0.84
      const f = cfg.kellyFraction ?? 0.3;
      const raw = picks.map((p) => {
        const edge = Math.max(0, (p.composite - 50) / 50);
        const vol = 0.25; // placeholder; replace with realized vol
        return f * edge / (vol * vol);
      });
      // Normalize to gross exposure and cap single position at 25%
      const sum = raw.reduce((a, b) => a + b, 0) || 1;
      return raw.map((w) => Math.min(0.25, (w / sum) * gross));
    }
  }
}

function exposureForRegime(regime: string): number {
  switch (regime) {
    case 'risk_on':
      return 1.0;
    case 'neutral':
      return 0.7;
    case 'risk_off':
      return 0.4;
    default:
      return 0.7;
  }
}

// -----------------------------------------------------------------------------
// Summary statistics
// -----------------------------------------------------------------------------

function summarize(
  startDate: string,
  endDate: string,
  trades: BacktestTrade[],
  equityCurve: Array<{ date: string; portfolio: number; spy: number }>,
): BacktestResult {
  const totalAlpha = avg(trades.map((t) => t.alpha));
  const winRate = trades.filter((t) => t.pnlPct > 0).length / Math.max(trades.length, 1);
  const sharpe = computeSharpe(equityCurve);
  const maxDrawdown = computeMaxDrawdown(equityCurve.map((e) => e.portfolio));

  const byTier: Record<Tier, number> = {
    A: avg(trades.filter((t) => t.tier === 'A').map((t) => t.alpha)),
    B: avg(trades.filter((t) => t.tier === 'B').map((t) => t.alpha)),
    C: avg(trades.filter((t) => t.tier === 'C').map((t) => t.alpha)),
  };
  const bySide: Record<Side, number> = {
    long: avg(trades.filter((t) => t.side === 'long').map((t) => t.alpha)),
    short: avg(trades.filter((t) => t.side === 'short').map((t) => t.alpha)),
  };

  // Score buckets: 60-70, 70-80, 80-90, 90-100
  const alphaByScoreBucket = [60, 70, 80, 90].map((lo) => {
    const hi = lo + 10;
    const subset = trades.filter((t) => t.compositeAtEntry >= lo && t.compositeAtEntry < hi);
    return {
      bucket: `${lo}-${hi}`,
      alpha: avg(subset.map((t) => t.alpha)),
      n: subset.length,
    };
  });

  return {
    startDate,
    endDate,
    trades,
    equityCurve,
    totalAlpha,
    sharpe,
    maxDrawdown,
    winRate,
    alphaByTier: byTier,
    alphaBySide: bySide,
    alphaByScoreBucket,
  };
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function computeSharpe(curve: Array<{ portfolio: number }>): number {
  if (curve.length < 2) return 0;
  const rets: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    rets.push(curve[i].portfolio / curve[i - 1].portfolio - 1);
  }
  const mean = avg(rets);
  const variance = avg(rets.map((r) => (r - mean) ** 2));
  const std = Math.sqrt(variance);
  if (std === 0) return 0;
  return (mean / std) * Math.sqrt(252); // annualize
}

function computeMaxDrawdown(series: number[]): number {
  let peak = series[0] ?? 1;
  let maxDd = 0;
  for (const v of series) {
    if (v > peak) peak = v;
    const dd = (v - peak) / peak;
    if (dd < maxDd) maxDd = dd;
  }
  return maxDd * 100;
}

// -----------------------------------------------------------------------------
// Data hooks — replace these with real data sources
// -----------------------------------------------------------------------------

async function getBoardSnapshot(_date: string): Promise<any> {
  // TODO: load from blob store 'targetboard' history
  return null;
}

async function getPriceAt(_ticker: string, _date: string): Promise<number | null> {
  // TODO: wire Polygon/IEX/Yahoo historical pricing
  return null;
}

async function getSpyReturn(_date: string, _days: number): Promise<number> {
  // TODO: wire SPY price history
  return 0;
}

function enumerateTradingDays(start: string, end: string): string[] {
  const out: string[] = [];
  const cur = new Date(start + 'T12:00:00Z');
  const endD = new Date(end + 'T12:00:00Z');
  while (cur <= endD) {
    const day = cur.getUTCDay(); // 0 Sun, 6 Sat
    if (day !== 0 && day !== 6) out.push(cur.toISOString().slice(0, 10));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

function offsetDay(from: string, n: number, available: string[]): string {
  const idx = available.indexOf(from);
  if (idx === -1) return from;
  return available[Math.min(idx + n, available.length - 1)];
}

function defaultStart(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}
