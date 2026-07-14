// FABLE-2 R1 — policy engine unit tests. Synthetic fixtures pin the
// trading mechanics: banded entry/exit, stop, max-hold, entry-only
// regime gating, costs, delisting close-out, IC plumbing, and the
// no-lookahead invariant on forward returns.

import { describe, it, expect } from 'vitest';
import {
  runPolicyBacktest,
  monthEndCheckpoints,
  spearman,
  pctlAmong,
  DEFAULT_POLICY_CONFIG,
  type PolicyInputs,
  type PolicyTickerData,
  type PolicyConfig,
} from '../policy-engine';
import type { FableBar } from '../../fable-scoring';

const DAY = 86_400_000;

/** Weekday bars from `from` for `n` trading days via a close-path fn. */
function mkBars(from: string, n: number, closeAt: (i: number) => number, vol = 5_000_000): FableBar[] {
  const bars: FableBar[] = [];
  let t = Date.parse(`${from}T12:00:00Z`);
  let i = 0;
  while (bars.length < n) {
    const dow = new Date(t).getUTCDay();
    if (dow !== 0 && dow !== 6) {
      const c = closeAt(i);
      bars.push({ t, o: c * 0.999, h: c * 1.005, l: c * 0.995, c, v: vol });
      i++;
    }
    t += DAY;
  }
  return bars;
}

/** Strong Minervini-passing uptrend with mild wiggle. */
const up = (base: number, g = 1.0016) => (i: number) =>
  base * Math.pow(g, i) * (1 + 0.006 * Math.sin(i / 3) + 0.004 * Math.sin(i / 7));
const down = (base: number) => (i: number) => base * Math.pow(0.9985, i) * (1 + 0.004 * Math.sin(i / 5));

const START_BARS = '2016-01-04';
const N = 900; // bars per series (~3.5y) — sim window sits inside the tail

function windowFor(spy: FableBar[], warmupBars = 400): { startDate: string; endDate: string } {
  const startDate = new Date(spy[warmupBars].t).toISOString().slice(0, 10);
  const endDate = new Date(spy[spy.length - 1].t).toISOString().slice(0, 10);
  return { startDate, endDate };
}

function baseInputs(overrides: Partial<PolicyConfig> = {}, tickers?: PolicyTickerData[]): PolicyInputs {
  const spy = mkBars(START_BARS, N, up(400, 1.0005));
  const { startDate, endDate } = windowFor(spy);
  const ts: PolicyTickerData[] =
    tickers ??
    [
      { ticker: 'WIN', bars: mkBars(START_BARS, N, up(100, 1.002)) },
      { ticker: 'MID', bars: mkBars(START_BARS, N, up(80, 1.0012)) },
      { ticker: 'LOSE', bars: mkBars(START_BARS, N, down(120)) },
    ];
  const config: PolicyConfig = {
    ...DEFAULT_POLICY_CONFIG,
    startDate,
    endDate,
    enterPctl: 0, // by default in tests: every passer enterable
    exitPctl: 0, //  and no band exits — individual tests override
    regimeMode: 'none',
    ...overrides,
  };
  return { tickers: ts, spyBars: spy, checkpoints: monthEndCheckpoints(spy, startDate, endDate), config };
}

describe('policy-engine — mechanics', () => {
  it('enters gate-passing uptrends, never enters the downtrend, and equity grows', () => {
    const res = runPolicyBacktest(baseInputs());
    const entered = new Set(res.trades.map((t) => t.ticker));
    expect(entered.has('WIN')).toBe(true);
    expect(entered.has('LOSE')).toBe(false);
    expect(res.metrics.totalReturnPct).toBeGreaterThan(0);
    expect(res.equity.length).toBeGreaterThan(300);
    expect(res.metrics.exposureAvgPct).toBeGreaterThan(10);
  });

  it('max-hold exits at exactly the configured trading-day count', () => {
    const res = runPolicyBacktest(baseInputs({ maxHoldDays: 40 }));
    const closed = res.trades.filter((t) => t.exitReason === 'max-hold');
    expect(closed.length).toBeGreaterThan(0);
    for (const t of closed) expect(t.holdTradingDays).toBe(40);
  });

  it('stop exits fire when a crash breaches entry*(1-stopPct)', () => {
    // Uptrend that qualifies, then collapses 30% over ~10 days mid-window.
    const crashAt = 550;
    const path = (i: number) => {
      const v = up(100, 1.002)(i);
      if (i < crashAt) return v;
      return v * Math.max(0.65, 1 - 0.035 * (i - crashAt));
    };
    const res = runPolicyBacktest(
      baseInputs({}, [{ ticker: 'CRASH', bars: mkBars(START_BARS, N, path) }]),
    );
    const stop = res.trades.find((t) => t.ticker === 'CRASH' && t.exitReason === 'stop');
    expect(stop).toBeDefined();
    // loss bounded near stopPct + slippage + one-day gap tolerance
    expect(stop!.returnPct!).toBeLessThan(-6);
    expect(stop!.returnPct!).toBeGreaterThan(-16);
  });

  it('band exit: exitPctl=60 sells the weakest passer at a checkpoint', () => {
    const res = runPolicyBacktest(baseInputs({ enterPctl: 0, exitPctl: 60 }));
    // MID or WIN whichever ranks <60th pctile among passers gets rotated out at some point
    expect(res.trades.some((t) => t.exitReason === 'band-exit')).toBe(true);
  });

  it('entry banding: enterPctl=90 admits only the top of the cross-section', () => {
    // 12 passers with distinct strengths — only ~top decile should ever be entered.
    const ts: PolicyTickerData[] = Array.from({ length: 12 }, (_, k) => ({
      ticker: `T${k}`,
      bars: mkBars(START_BARS, N, up(50 + k, 1.0008 + 0.00012 * k)),
    }));
    const res = runPolicyBacktest(baseInputs({ enterPctl: 90, exitPctl: 0 }, ts));
    const entered = new Set(res.trades.map((t) => t.ticker));
    expect(entered.size).toBeLessThanOrEqual(4); // top ~10% of 12 ≈ 1-2, allow slack for rank shuffles
    expect(entered.has('T11')).toBe(true); // the strongest must be among them
    expect(entered.has('T0')).toBe(false);
  });

  it("regimeMode 'entry-only': no entries while SPY < SMA200, but holdings keep running", () => {
    // SPY: up for 500 bars then hard bear for the rest.
    const spyPath = (i: number) => (i < 500 ? 400 * Math.pow(1.0012, i) : 400 * Math.pow(1.0012, 500) * Math.pow(0.9975, i - 500));
    const spy = mkBars(START_BARS, N, spyPath);
    const { startDate, endDate } = windowFor(spy);
    const ts: PolicyTickerData[] = [{ ticker: 'WIN', bars: mkBars(START_BARS, N, up(100, 1.002)) }];
    // maxHoldDays 30 forces churn: exits mid-month, re-entries at the next
    // checkpoint — so entry gating has something to block in the bear phase.
    const mk = (regimeMode: PolicyConfig['regimeMode']) =>
      runPolicyBacktest({
        tickers: ts,
        spyBars: spy,
        checkpoints: monthEndCheckpoints(spy, startDate, endDate),
        config: { ...DEFAULT_POLICY_CONFIG, startDate, endDate, enterPctl: 0, exitPctl: 0, regimeMode, maxHoldDays: 30 },
      });
    const gated = mk('entry-only');
    const ungated = mk('none');
    // Bear regime begins shortly after the peak at bar 500 (SMA200 crossover
    // lags it). Re-entries after the crossover exist only in the ungated run.
    const spyIso = (i: number) => new Date(spy[i].t).toISOString().slice(0, 10);
    const bearStart = spyIso(760); // safely past the crossover
    const lateEntries = (r: typeof gated) => r.trades.filter((t) => t.entryDate >= bearStart).length;
    expect(lateEntries(ungated)).toBeGreaterThan(0);
    expect(lateEntries(gated)).toBe(0);
    // gating blocks entries only — it never force-liquidates on regime flip
    expect(gated.trades.some((t) => t.exitReason === 'max-hold')).toBe(true);
  });

  it('costs: roundTripCostPct grows with trade count and slippage is charged both legs', () => {
    const cheap = runPolicyBacktest(baseInputs({ slippageBpsPerLeg: 0 }));
    const costly = runPolicyBacktest(baseInputs({ slippageBpsPerLeg: 25 }));
    expect(cheap.metrics.roundTripCostPct).toBe(0);
    expect(costly.metrics.roundTripCostPct).toBeGreaterThan(0);
    expect(costly.metrics.totalReturnPct).toBeLessThan(cheap.metrics.totalReturnPct);
  });

  it('delisting: a series that ends mid-window is force-exited at last known close', () => {
    const short = mkBars(START_BARS, 650, up(100, 1.002)); // ends ~250 bars early
    const res = runPolicyBacktest(baseInputs({}, [{ ticker: 'GONE', bars: short }]));
    const t = res.trades.find((x) => x.ticker === 'GONE');
    expect(t).toBeDefined();
    expect(t!.exitDate).not.toBeNull();
    // NAV never NaN
    for (const row of res.equity) expect(Number.isFinite(row.value)).toBe(true);
  });

  it('IC plumbing: rankIc63 is computed and positive when composite orders forward returns', () => {
    // 14 passers whose growth rates strictly increase with composite drivers
    const ts: PolicyTickerData[] = Array.from({ length: 14 }, (_, k) => ({
      ticker: `S${k}`,
      bars: mkBars(START_BARS, N, up(60, 1.0006 + 0.00016 * k)),
    }));
    const res = runPolicyBacktest(baseInputs({}, ts));
    expect(res.metrics.icCheckpoints63).toBeGreaterThan(3);
    expect(res.metrics.rankIc63).not.toBeNull();
    expect(res.metrics.rankIc63!).toBeGreaterThan(0.2);
  });

  it('no lookahead: forward-return pairs never read bars beyond endDate', () => {
    // End the window 40 bars before the series ends; 63d forward from the last
    // checkpoints must be EXCLUDED (not silently read from post-end bars).
    // Needs enough passers (≥10) for IC pairs to form at all.
    const many: PolicyTickerData[] = Array.from({ length: 14 }, (_, k) => ({
      ticker: `S${k}`,
      bars: mkBars(START_BARS, N, up(60, 1.0006 + 0.00016 * k)),
    }));
    const spy = mkBars(START_BARS, N, up(400, 1.0005));
    const endEarly = new Date(spy[N - 41].t).toISOString().slice(0, 10);
    const { startDate } = windowFor(spy);
    const full = baseInputs({}, many);
    const early = runPolicyBacktest({
      ...full,
      checkpoints: monthEndCheckpoints(spy, startDate, endEarly),
      config: { ...full.config, endDate: endEarly },
    });
    const resFull = runPolicyBacktest(baseInputs({}, many));
    expect(resFull.metrics.icCheckpoints63).toBeGreaterThan(0);
    expect(early.metrics.icCheckpoints63).toBeLessThan(resFull.metrics.icCheckpoints63);
  });
});

describe('policy-engine — helpers', () => {
  it('spearman: perfect order = 1, inverse = -1, degenerate = null', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 9);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 9);
    expect(spearman([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2], [1, 2])).toBeNull();
  });

  it('pctlAmong: endpoints and ties', () => {
    expect(pctlAmong([5])).toEqual([100]);
    const p = pctlAmong([10, 20, 30, 40, 50]);
    expect(p[0]).toBe(0);
    expect(p[4]).toBe(100);
    const tied = pctlAmong([1, 2, 2, 3]);
    expect(tied[1]).toBeCloseTo(tied[2], 9);
  });

  it('monthEndCheckpoints returns the last trading day per month inside the window', () => {
    const spy = mkBars('2020-01-02', 120, up(300, 1.0005));
    const cps = monthEndCheckpoints(spy, '2020-01-01', '2020-06-30');
    expect(cps.length).toBeGreaterThanOrEqual(5);
    for (const d of cps) expect(new Date(`${d}T12:00:00Z`).getUTCDay()).toBeGreaterThan(0);
    // strictly ascending, one per month
    const months = cps.map((d) => d.slice(0, 7));
    expect(new Set(months).size).toBe(months.length);
  });
});
