// FABLE-2 R1 — pure policy-mode backtest engine.
//
// Simulates the board's ACTUAL trading discipline (which v1's monthly
// top-N full-rotation proxy did not): banded entry/exit among gate-
// passers, per-position max-hold and stop, hybrid composite×size
// weighting, entry-only regime gating, partial cash. Event-driven daily
// loop over in-memory bar series — NO I/O in this module (the data
// layer, policy-data.ts, assembles inputs; this stays pure and fully
// unit-testable).
//
// Design provenance: reports/fable2/protocol.md §2 (H1-H4) + §4.
// v1 scoring is reused verbatim via fable-scoring.ts — the SCORE is
// unchanged; what changed is portfolio construction. Pre-registered
// before any run: this engine ships with its exploration clamp
// (endDate ≤ TRAIN_END for exploration runs) enforced at the runner.
//
// PIT integrity: all scoring at checkpoint t uses bars.slice(0, i+1)
// (bars up to and including t) and insider transactions filed ≤ t —
// the pure scoreFable clips internally by asOfIso as well (belt and
// suspenders). Fills happen at the SAME day's close as the decision,
// with slippage — no lookahead beyond the close that triggered the
// decision. Stops evaluate on daily close (conservative: no intraday
// low magic), fill at that close minus slippage.

import {
  scoreFable,
  evaluateFoundationGate,
  FABLE_CONSTANTS,
  type FableBar,
  type FableInsiderTx,
} from '../fable-scoring';

// ---------------------------------------------------------------------------
// Config + result types
// ---------------------------------------------------------------------------

export interface PolicyConfig {
  /** Simulation window (inclusive, YYYY-MM-DD). */
  startDate: string;
  endDate: string;
  initialCapital: number;
  /** Entry band: enter names at or above this percentile among gate-passers. */
  enterPctl: number; // v1 design: 90
  /** Exit band: exit names below this percentile among gate-passers. */
  exitPctl: number; // v1 design: 60
  /** Max holding period in TRADING days; exit at close when reached. */
  maxHoldDays: number; // v1 design: 126
  /** Fixed initial stop, fraction below entry fill (0.08 = -8%). */
  stopPct: number;
  /** Per-leg slippage in bps (10 ⇒ 20bps round trip). */
  slippageBpsPerLeg: number;
  /** Position sizing: weight ∝ composite × (sizeProxy ^ sizeAlpha). */
  sizeAlpha: number; // 0 = pure composite; 1 = strongly size-tilted
  /** Hard cap per position as fraction of NAV at entry. */
  maxPositionPct: number;
  /** Hard cap on simultaneous positions. */
  maxPositions: number;
  /**
   * Regime gating mode:
   *  'entry-only'  — SPY close < SMA200 at checkpoint ⇒ no NEW entries,
   *                  existing positions keep running with their stops. (H3)
   *  'cash'        — v1 behavior: no entries AND banding exits still apply.
   *  'none'        — no regime gate.
   */
  regimeMode: 'entry-only' | 'cash' | 'none';
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  startDate: '2018-01-01',
  endDate: '2023-12-29',
  initialCapital: 100_000,
  enterPctl: 90,
  exitPctl: 60,
  maxHoldDays: 126,
  stopPct: 0.08,
  slippageBpsPerLeg: 10,
  sizeAlpha: 1.0,
  maxPositionPct: 0.10,
  maxPositions: 30,
  regimeMode: 'entry-only',
};

/** Bars + optional insider txs per checkpoint index for one ticker. */
export interface PolicyTickerData {
  ticker: string;
  bars: FableBar[]; // full series, ascending, spanning warmup→endDate
  /** insider txs known as of each checkpoint (index-aligned with checkpoints). */
  insiderByCheckpoint?: Array<FableInsiderTx[] | undefined>;
}

export interface PolicyInputs {
  tickers: PolicyTickerData[];
  spyBars: FableBar[];
  /** Checkpoint dates (YYYY-MM-DD), ascending — normally month-ends. */
  checkpoints: string[];
  config: PolicyConfig;
}

export interface PolicyTrade {
  ticker: string;
  entryDate: string;
  entryPx: number; // fill incl. slippage
  exitDate: string | null;
  exitPx: number | null; // fill incl. slippage
  exitReason: 'stop' | 'max-hold' | 'band-exit' | 'gate-fail' | 'end' | null;
  returnPct: number | null;
  holdTradingDays: number | null;
}

export interface PolicyMetrics {
  totalReturnPct: number;
  spyTotalReturnPct: number;
  excessVsSpyPp: number;
  cagrPct: number;
  sharpe: number;
  maxDrawdownPct: number;
  /** t-stat of mean monthly active return vs SPY. */
  monthlyActiveT: number;
  meanMonthlyActivePct: number;
  /** Mean Spearman rank-IC of checkpoint composites vs forward returns. */
  rankIc63: number | null;
  rankIc126: number | null;
  icCheckpoints63: number;
  icCheckpoints126: number;
  tradeCount: number;
  roundTripCostPct: number; // total cost drag as % of initial capital
  avgHoldTradingDays: number | null;
  winRatePct: number | null;
  exposureAvgPct: number; // average invested fraction of NAV
  checkpointCount: number;
  gatePassersAvg: number;
}

export interface PolicyResult {
  equity: Array<{ date: string; value: number; spy: number }>;
  trades: PolicyTrade[];
  metrics: PolicyMetrics;
  warnings: string[];
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function isoOf(t: number): string {
  return new Date(t).toISOString().slice(0, 10);
}

/** Spearman rank correlation; null when degenerate (<3 pairs or zero var). */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const rank = (v: number[]): number[] => {
    const idx = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array(n).fill(0);
    let i = 0;
    while (i < n) {
      let j = i;
      while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const mx = rx.reduce((a, b) => a + b, 0) / n;
  const my = ry.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let k = 0; k < n; k++) {
    num += (rx[k] - mx) * (ry[k] - my);
    dx += (rx[k] - mx) ** 2;
    dy += (ry[k] - my) ** 2;
  }
  if (dx === 0 || dy === 0) return null;
  return num / Math.sqrt(dx * dy);
}

/** Percentile (0-100) of each value among the array (ties = mean rank). */
export function pctlAmong(values: number[]): number[] {
  const n = values.length;
  if (n === 1) return [100];
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array(n).fill(0);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && idx[j + 1][0] === idx[i][0]) j++;
    const avgRank = (i + j) / 2;
    const p = (avgRank / (n - 1)) * 100;
    for (let k = i; k <= j; k++) out[idx[k][1]] = p;
    i = j + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

interface OpenPosition {
  ticker: string;
  entryDate: string;
  entryPx: number; // fill incl. slippage
  shares: number;
  stopPx: number;
  entryTradingDayIdx: number; // index into the global calendar
  /** Most recent close seen — valuation + forced-exit price for series that end (delistings/mergers). */
  lastClose: number;
  tradeRef: PolicyTrade;
}

export function runPolicyBacktest(inputs: PolicyInputs): PolicyResult {
  const { tickers, spyBars, checkpoints, config } = inputs;
  const warnings: string[] = [];
  const slip = config.slippageBpsPerLeg / 10_000;

  // --- Global trading calendar from SPY, clipped to [startDate, endDate]
  const cal: string[] = [];
  const spyCloseByDate = new Map<string, number>();
  for (const b of spyBars) {
    const d = isoOf(b.t);
    spyCloseByDate.set(d, b.c);
    if (d >= config.startDate && d <= config.endDate) cal.push(d);
  }
  if (cal.length < 100) {
    throw new Error(`policy-engine: calendar too short (${cal.length} days) — check spyBars/window`);
  }
  const calIdx = new Map(cal.map((d, i) => [d, i] as const));

  // SPY SMA200 per calendar day (for regime gating), computed over the FULL
  // spy series so early sim days have history.
  const spyAll = spyBars.map((b) => ({ d: isoOf(b.t), c: b.c }));
  const spySma200ByDate = new Map<string, number>();
  {
    let sum = 0;
    const q: number[] = [];
    for (const { d, c } of spyAll) {
      q.push(c);
      sum += c;
      if (q.length > 200) sum -= q.shift()!;
      if (q.length === 200) spySma200ByDate.set(d, sum / 200);
    }
  }

  // --- Per-ticker date→index maps (bars are ascending)
  interface TickerCtx {
    t: PolicyTickerData;
    dateToIdx: Map<string, number>;
    closeByDate: Map<string, number>;
  }
  const ctxs: TickerCtx[] = tickers.map((t) => {
    const dateToIdx = new Map<string, number>();
    const closeByDate = new Map<string, number>();
    t.bars.forEach((b, i) => {
      const d = isoOf(b.t);
      dateToIdx.set(d, i);
      closeByDate.set(d, b.c);
    });
    return { t, dateToIdx, closeByDate };
  });
  const ctxByTicker = new Map(ctxs.map((c) => [c.t.ticker, c] as const));

  // Checkpoint set for O(1) membership; only checkpoints inside the window count.
  const cps = checkpoints.filter((d) => d >= config.startDate && d <= config.endDate);
  const cpSet = new Set(cps);
  const cpIndexOf = new Map(cps.map((d, i) => [d, i] as const));
  // Map checkpoint date → index in the ORIGINAL checkpoints array (for insiderByCheckpoint alignment)
  const cpOrigIdx = new Map(checkpoints.map((d, i) => [d, i] as const));

  // --- State
  let cash = config.initialCapital;
  const open = new Map<string, OpenPosition>();
  const trades: PolicyTrade[] = [];
  const equity: Array<{ date: string; value: number; spy: number }> = [];
  let peak = config.initialCapital;
  let maxDd = 0;
  let costPaid = 0;
  let exposureSum = 0;
  let gatePassSum = 0;

  // IC accumulators: per checkpoint, passers' composites + forward returns.
  const icPairs63: Array<{ comp: number[]; fwd: number[] }> = [];
  const icPairs126: Array<{ comp: number[]; fwd: number[] }> = [];

  const sellAt = (pos: OpenPosition, date: string, px: number, reason: PolicyTrade['exitReason']) => {
    const fill = px * (1 - slip);
    cash += pos.shares * fill;
    costPaid += pos.shares * px * slip;
    const tr = pos.tradeRef;
    tr.exitDate = date;
    tr.exitPx = fill;
    tr.exitReason = reason;
    tr.returnPct = (fill / pos.entryPx - 1) * 100;
    tr.holdTradingDays = (calIdx.get(date) ?? 0) - pos.entryTradingDayIdx;
    open.delete(pos.ticker);
  };

  // --- Daily loop
  for (let di = 0; di < cal.length; di++) {
    const date = cal[di];

    // 1) Daily position management: stops + max-hold, evaluated on close.
    for (const pos of Array.from(open.values())) {
      const ctx = ctxByTicker.get(pos.ticker)!;
      const close = ctx.closeByDate.get(date);
      if (close === undefined) continue; // halted day — hold at lastClose
      pos.lastClose = close;
      if (close <= pos.stopPx) {
        sellAt(pos, date, close, 'stop');
        continue;
      }
      if (di - pos.entryTradingDayIdx >= config.maxHoldDays) {
        sellAt(pos, date, close, 'max-hold');
      }
    }

    // 2) Checkpoint: score, band exits, then entries.
    if (cpSet.has(date)) {
      const scored: Array<{ ticker: string; composite: number; ctx: TickerCtx; barIdx: number }> = [];
      let passers = 0;
      for (const ctx of ctxs) {
        const bi = ctx.dateToIdx.get(date);
        if (bi === undefined || bi + 1 < FABLE_CONSTANTS.MIN_BARS) continue;
        const view = ctx.t.bars.slice(0, bi + 1);
        if (!evaluateFoundationGate(view).pass) continue;
        passers++;
        const oi = cpOrigIdx.get(date) ?? -1;
        const txs = (oi >= 0 ? ctx.t.insiderByCheckpoint?.[oi] : undefined) ?? [];
        const s = scoreFable(view, spyBars, txs, date);
        if (!s) continue; // gate re-check inside; defensive
        scored.push({ ticker: ctx.t.ticker, composite: s.composite, ctx, barIdx: bi });
      }
      gatePassSum += passers;

      const pctls = pctlAmong(scored.map((s) => s.composite));
      const pctlByTicker = new Map(scored.map((s, i) => [s.ticker, pctls[i]] as const));

      // IC bookkeeping: composite vs forward 63d/126d returns (by bar index).
      const fwd = (s: { ctx: TickerCtx; barIdx: number }, n: number): number | null => {
        const b = s.ctx.t.bars;
        const j = s.barIdx + n;
        if (j >= b.length) return null;
        const later = isoOf(b[j].t);
        if (later > config.endDate) return null; // never read past the window
        return b[j].c / b[s.barIdx].c - 1;
      };
      const p63: { comp: number[]; fwd: number[] } = { comp: [], fwd: [] };
      const p126: { comp: number[]; fwd: number[] } = { comp: [], fwd: [] };
      for (const s of scored) {
        const f63 = fwd(s, 63);
        if (f63 !== null) {
          p63.comp.push(s.composite);
          p63.fwd.push(f63);
        }
        const f126 = fwd(s, 126);
        if (f126 !== null) {
          p126.comp.push(s.composite);
          p126.fwd.push(f126);
        }
      }
      if (p63.comp.length >= 10) icPairs63.push(p63);
      if (p126.comp.length >= 10) icPairs126.push(p126);

      // 2a) Band exits (and gate-fail exits) — always active, all regimes
      // except 'entry-only' semantics do NOT change exits.
      for (const pos of Array.from(open.values())) {
        const p = pctlByTicker.get(pos.ticker);
        const ctx = ctxByTicker.get(pos.ticker)!;
        const close = ctx.closeByDate.get(date);
        if (close === undefined) {
          // Series ended (delisting/merger)? If the ticker has no bars on or
          // after this checkpoint, exit at the last known close — never let a
          // dead series sit marked-at-entry holding a position slot.
          const lastBar = ctx.t.bars[ctx.t.bars.length - 1];
          if (lastBar && isoOf(lastBar.t) < date) sellAt(pos, date, pos.lastClose, 'gate-fail');
          continue;
        }
        if (p === undefined) {
          // no longer a gate-passer
          sellAt(pos, date, close, 'gate-fail');
        } else if (p < config.exitPctl) {
          sellAt(pos, date, close, 'band-exit');
        }
      }

      // 2b) Entries — regime-gated.
      const spySma = spySma200ByDate.get(date);
      const spyClose = spyCloseByDate.get(date);
      const regimeOk =
        config.regimeMode === 'none' ||
        spySma === undefined ||
        spyClose === undefined ||
        spyClose > spySma;
      if (regimeOk) {
        const nav = markToMarket(date);
        const candidates = scored
          .filter((s) => (pctlByTicker.get(s.ticker) ?? 0) >= config.enterPctl)
          .filter((s) => !open.has(s.ticker))
          .map((s) => {
            // Size proxy: trailing 63d median dollar volume (PIT-safe cap proxy).
            const b = s.ctx.t.bars;
            const lo = Math.max(0, s.barIdx - 62);
            const dv: number[] = [];
            for (let k = lo; k <= s.barIdx; k++) dv.push(b[k].c * (b[k].v || 0));
            dv.sort((a, z) => a - z);
            const proxy = dv[Math.floor(dv.length / 2)] || 1;
            return { ...s, weightRaw: s.composite * Math.pow(proxy, config.sizeAlpha) };
          })
          .sort((a, z) => z.weightRaw - a.weightRaw);

        const room = config.maxPositions - open.size;
        const picks = candidates.slice(0, Math.max(0, room));
        const rawSum = picks.reduce((a, p) => a + p.weightRaw, 0);
        if (rawSum > 0) {
          for (const p of picks) {
            const targetFrac = Math.min(config.maxPositionPct, (p.weightRaw / rawSum) * (cash / nav));
            const dollars = Math.min(cash, targetFrac * nav);
            if (dollars < nav * 0.005) continue; // dust guard
            const close = p.ctx.closeByDate.get(date)!;
            const fill = close * (1 + slip);
            const shares = dollars / fill;
            cash -= dollars;
            costPaid += shares * close * slip;
            const trade: PolicyTrade = {
              ticker: p.ticker,
              entryDate: date,
              entryPx: fill,
              exitDate: null,
              exitPx: null,
              exitReason: null,
              returnPct: null,
              holdTradingDays: null,
            };
            trades.push(trade);
            open.set(p.ticker, {
              ticker: p.ticker,
              entryDate: date,
              entryPx: fill,
              shares,
              stopPx: fill * (1 - config.stopPct),
              entryTradingDayIdx: di,
              lastClose: close,
              tradeRef: trade,
            });
          }
        }
      }
    }

    // 3) Mark to market + equity row.
    const nav = markToMarket(date);
    exposureSum += nav > 0 ? (nav - cash) / nav : 0;
    if (nav > peak) peak = nav;
    const dd = peak > 0 ? (peak - nav) / peak : 0;
    if (dd > maxDd) maxDd = dd;
    equity.push({ date, value: nav, spy: spyCloseByDate.get(date) ?? NaN });
  }

  // Close remaining positions at final close (bookkeeping exit, reason 'end').
  const last = cal[cal.length - 1];
  for (const pos of Array.from(open.values())) {
    const ctx = ctxByTicker.get(pos.ticker)!;
    const close = ctx.closeByDate.get(last) ?? pos.lastClose;
    sellAt(pos, last, close, 'end');
  }

  function markToMarket(date: string): number {
    let nav = cash;
    for (const pos of open.values()) {
      const ctx = ctxByTicker.get(pos.ticker)!;
      const c = ctx.closeByDate.get(date);
      nav += pos.shares * (c !== undefined ? c : pos.lastClose);
    }
    return nav;
  }

  // --- Metrics
  const startNav = config.initialCapital;
  const endNav = equity[equity.length - 1]?.value ?? startNav;
  const spyStart = equity[0]?.spy;
  const spyEnd = equity[equity.length - 1]?.spy;
  const totalReturnPct = (endNav / startNav - 1) * 100;
  const spyTotalReturnPct = spyStart && spyEnd ? (spyEnd / spyStart - 1) * 100 : NaN;

  // Monthly resample for active t-stat + sharpe.
  const monthEnd = new Map<string, { v: number; s: number }>();
  for (const row of equity) monthEnd.set(row.date.slice(0, 7), { v: row.value, s: row.spy });
  const months = Array.from(monthEnd.keys()).sort();
  const mv = months.map((m) => monthEnd.get(m)!);
  const stratR: number[] = [];
  const activeR: number[] = [];
  for (let i = 1; i < mv.length; i++) {
    const rs = mv[i].v / mv[i - 1].v - 1;
    const rb = mv[i].s / mv[i - 1].s - 1;
    stratR.push(rs);
    activeR.push(rs - rb);
  }
  const mean = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
  const sd = (a: number[]) => {
    if (a.length < 2) return 0;
    const m = mean(a);
    return Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / (a.length - 1));
  };
  const mAct = mean(activeR);
  const sAct = sd(activeR);
  const monthlyActiveT = sAct > 0 ? (mAct / (sAct / Math.sqrt(activeR.length))) : 0;
  const sharpe = sd(stratR) > 0 ? (mean(stratR) / sd(stratR)) * Math.sqrt(12) : 0;
  const years = Math.max(0.5, cal.length / 252);
  const cagrPct = (Math.pow(endNav / startNav, 1 / years) - 1) * 100;

  const icAvg = (pairs: Array<{ comp: number[]; fwd: number[] }>): number | null => {
    const vals = pairs.map((p) => spearman(p.comp, p.fwd)).filter((v): v is number => v !== null);
    return vals.length ? mean(vals) : null;
  };

  const closed = trades.filter((t) => t.returnPct !== null);
  const wins = closed.filter((t) => (t.returnPct ?? 0) > 0).length;

  const metrics: PolicyMetrics = {
    totalReturnPct: +totalReturnPct.toFixed(4),
    spyTotalReturnPct: +spyTotalReturnPct.toFixed(4),
    excessVsSpyPp: +(totalReturnPct - spyTotalReturnPct).toFixed(2),
    cagrPct: +cagrPct.toFixed(3),
    sharpe: +sharpe.toFixed(3),
    maxDrawdownPct: +(maxDd * 100).toFixed(2),
    monthlyActiveT: +monthlyActiveT.toFixed(3),
    meanMonthlyActivePct: +(mAct * 100).toFixed(4),
    rankIc63: icAvg(icPairs63) !== null ? +icAvg(icPairs63)!.toFixed(4) : null,
    rankIc126: icAvg(icPairs126) !== null ? +icAvg(icPairs126)!.toFixed(4) : null,
    icCheckpoints63: icPairs63.length,
    icCheckpoints126: icPairs126.length,
    tradeCount: trades.length,
    roundTripCostPct: +((costPaid / startNav) * 100).toFixed(3),
    avgHoldTradingDays: closed.length
      ? +(closed.reduce((a, t) => a + (t.holdTradingDays ?? 0), 0) / closed.length).toFixed(1)
      : null,
    winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(2) : null,
    exposureAvgPct: +((exposureSum / cal.length) * 100).toFixed(2),
    checkpointCount: cps.length,
    gatePassersAvg: cps.length ? +(gatePassSum / cps.length).toFixed(1) : 0,
  };

  if (Number.isNaN(spyTotalReturnPct)) warnings.push('spy-series-gap: benchmark totals degraded');
  if (metrics.checkpointCount < 12) warnings.push(`few-checkpoints: ${metrics.checkpointCount}`);

  return { equity, trades, metrics, warnings };
}

/** Last trading day of each month present in the SPY calendar within [start,end]. */
export function monthEndCheckpoints(spyBars: FableBar[], startDate: string, endDate: string): string[] {
  const byMonth = new Map<string, string>();
  for (const b of spyBars) {
    const d = isoOf(b.t);
    if (d < startDate || d > endDate) continue;
    byMonth.set(d.slice(0, 7), d); // ascending — last write wins
  }
  return Array.from(byMonth.values()).sort();
}
