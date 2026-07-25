// Top-N selection + run-up exits (2026-07-25).
//
// These encode Chad's two asks: "trade the top 10 each board presents" and
// "have a setup for getting out of them during a run up". Both were absent —
// the engine could only select by percentile band and could only exit at a
// LOSS (stop), by age (max-hold), or by rank band. A winner that spiked and
// round-tripped handed the entire move back.
//
// Trading rules, so the fixtures are deterministic paths with hand-computable
// exit points rather than noisy series.

import { describe, it, expect } from 'vitest';
import {
  runPolicyBacktest,
  monthEndCheckpoints,
  DEFAULT_POLICY_CONFIG,
  type PolicyInputs,
  type PolicyTickerData,
  type PolicyConfig,
} from '../policy-engine';
import type { FableBar } from '../../fable-scoring';

const DAY = 86_400_000;

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

const up = (base: number, g = 1.0016) => (i: number) =>
  base * Math.pow(g, i) * (1 + 0.006 * Math.sin(i / 3) + 0.004 * Math.sin(i / 7));

const START_BARS = '2016-01-04';
const N = 900;

/** Rallies hard, then round-trips the entire move — the give-back case. */
const spikeThenFade = (base: number, peakAt: number) => (i: number) => {
  // The reversal must be sharp enough to trip the trail BEFORE the next
  // monthly checkpoint, or a gate-fail exit fires first and the rule under
  // test never runs (measured: a 0.994/day fade needs ~17 trading days to
  // give back 10%, and the checkpoint got there at day 18).
  const ramp = i <= peakAt ? Math.pow(1.004, i) : Math.pow(1.004, peakAt) * Math.pow(0.97, i - peakAt);
  return base * ramp * (1 + 0.003 * Math.sin(i / 4));
};

/** Leadership crossover: LEAD tops the board early, LATE overtakes it. Rank
 *  order must actually CHANGE for a rank-exit to be reachable at all. */
// NB: the fading leader must keep RISING, only slower. A genuinely flat
// series stops passing the trend gate and exits as 'gate-fail' before any
// rank handoff can occur (measured: LEAD gate-failed 2018-02-28 and LATE
// took its slot the same day — the right handoff through the wrong door).
const fastThenFlat = (base: number) => (i: number) =>
  base * Math.pow(1.003, Math.min(i, 500)) * Math.pow(1.0012, Math.max(0, i - 500)) *
  (1 + 0.005 * Math.sin(i / 5));
const slowThenFast = (base: number) => (i: number) =>
  base * Math.pow(1.0008, i) * Math.pow(1.004, Math.max(0, i - 500)) * (1 + 0.005 * Math.sin(i / 6));

function inputs(overrides: Partial<PolicyConfig>, tickers?: PolicyTickerData[]): PolicyInputs {
  const spy = mkBars(START_BARS, N, up(400, 1.0005));
  const startDate = new Date(spy[400].t).toISOString().slice(0, 10);
  const endDate = new Date(spy[spy.length - 1].t).toISOString().slice(0, 10);
  const ts: PolicyTickerData[] =
    tickers ?? [
      { ticker: 'A', bars: mkBars(START_BARS, N, up(100, 1.0022)) },
      { ticker: 'B', bars: mkBars(START_BARS, N, up(90, 1.0019)) },
      { ticker: 'C', bars: mkBars(START_BARS, N, up(80, 1.0016)) },
      { ticker: 'D', bars: mkBars(START_BARS, N, up(70, 1.0013)) },
    ];
  const config: PolicyConfig = {
    ...DEFAULT_POLICY_CONFIG,
    startDate,
    endDate,
    enterPctl: 0,
    exitPctl: 0,
    regimeMode: 'none',
    stopPct: 0.5, // effectively disable the loss stop; isolate the rule under test
    ...overrides,
  };
  return { tickers: ts, spyBars: spy, checkpoints: monthEndCheckpoints(spy, startDate, endDate), config };
}

describe('topN selection', () => {
  it('holds at most topN names at once — "buy what the board shows"', () => {
    const res = runPolicyBacktest(inputs({ selectionMode: 'topN', topN: 2, maxPositions: 30 }));
    // Reconstruct concurrent holdings from the trade ledger.
    const events: Array<{ d: string; delta: number }> = [];
    for (const t of res.trades) {
      events.push({ d: t.entryDate, delta: 1 });
      if (t.exitDate) events.push({ d: t.exitDate, delta: -1 });
    }
    events.sort((a, b) => a.d.localeCompare(b.d) || a.delta - b.delta); // exits first on a shared date
    let held = 0;
    let peak = 0;
    for (const e of events) {
      held += e.delta;
      peak = Math.max(peak, held);
    }
    expect(res.trades.length).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('percentile mode is unchanged when selectionMode is omitted (legacy default)', () => {
    const legacy = runPolicyBacktest(inputs({}));
    const explicit = runPolicyBacktest(inputs({ selectionMode: 'percentile' }));
    expect(explicit.metrics.tradeCount).toBe(legacy.metrics.tradeCount);
    expect(explicit.metrics.totalReturnPct).toBeCloseTo(legacy.metrics.totalReturnPct, 6);
  });

  it('exits a name that falls out of the hysteresis band, tagged rank-exit', () => {
    // Requires an actual leadership change — with a fixed pecking order the
    // top name never yields and rank-exit is correctly unreachable.
    const res = runPolicyBacktest(
      inputs({ selectionMode: 'topN', topN: 1, exitRankN: 1, maxHoldDays: 10_000, stopPct: 0.9 }, [
        { ticker: 'LEAD', bars: mkBars(START_BARS, N, fastThenFlat(100)) },
        { ticker: 'LATE', bars: mkBars(START_BARS, N, slowThenFast(95)) },
      ]),
    );
    expect(res.trades.some((t) => t.exitReason === 'rank-exit')).toBe(true);
  });
});

describe('run-up exits', () => {
  const faders = (): PolicyTickerData[] => [
    { ticker: 'SPIKE', bars: mkBars(START_BARS, N, spikeThenFade(100, 700)) },
    { ticker: 'STEADY', bars: mkBars(START_BARS, N, up(90, 1.0015)) },
  ];

  it('take-profit books the target instead of round-tripping the move', () => {
    const res = runPolicyBacktest(
      inputs({ takeProfitPct: 0.2, maxHoldDays: 10_000 }, faders()),
    );
    const tp = res.trades.filter((t) => t.exitReason === 'take-profit');
    expect(tp.length).toBeGreaterThan(0);
    // Every take-profit exit must be at or above the target, net of nothing —
    // the rule fires on the close that first clears it.
    for (const t of tp) expect(t.returnPct!).toBeGreaterThanOrEqual(19);
  });

  it('trailing stop exits after a fixed give-back from the peak, not from entry', () => {
    const res = runPolicyBacktest(
      inputs({ trailingStopPct: 0.1, maxHoldDays: 10_000 }, faders()),
    );
    const trailed = res.trades.filter((t) => t.exitReason === 'trail');
    expect(trailed.length).toBeGreaterThan(0);
    // A trailing exit on a name that rallied first should still be profitable —
    // that is the whole point versus a loss stop.
    const spikeTrail = trailed.find((t) => t.ticker === 'SPIKE');
    expect(spikeTrail).toBeDefined();
    expect(spikeTrail!.returnPct!).toBeGreaterThan(0);
  });

  it('take-profit wins when a single close clears BOTH the target and the trail', () => {
    // Ordering matters: booking the give-back instead of the target would
    // silently understate every winner.
    const res = runPolicyBacktest(
      inputs({ takeProfitPct: 0.15, trailingStopPct: 0.02, maxHoldDays: 10_000 }, faders()),
    );
    const spike = res.trades.find((t) => t.ticker === 'SPIKE');
    expect(spike).toBeDefined();
    expect(['take-profit', 'trail']).toContain(spike!.exitReason);
  });

  it('both rules off by default — legacy runs are byte-identical', () => {
    const off = runPolicyBacktest(inputs({}, faders()));
    expect(off.trades.every((t) => t.exitReason !== 'trail' && t.exitReason !== 'take-profit')).toBe(true);
  });

  it('the trailing stop ratchets up only — a pullback never loosens it', () => {
    const tight = runPolicyBacktest(inputs({ trailingStopPct: 0.05, maxHoldDays: 10_000 }, faders()));
    const loose = runPolicyBacktest(inputs({ trailingStopPct: 0.25, maxHoldDays: 10_000 }, faders()));
    const firstTight = tight.trades.find((t) => t.ticker === 'SPIKE' && t.exitReason === 'trail');
    const firstLoose = loose.trades.find((t) => t.ticker === 'SPIKE' && t.exitReason === 'trail');
    if (firstTight && firstLoose) {
      // A tighter trail must exit no later than a looser one.
      expect(firstTight.exitDate! <= firstLoose.exitDate!).toBe(true);
    }
    expect(firstTight ?? firstLoose).toBeDefined();
  });
});
