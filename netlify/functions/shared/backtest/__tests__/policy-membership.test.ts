// AUDIT-1 — point-in-time index membership in the fable-2 policy engine.
//
// Before this fix, every fable-2 run — including the +28.01pp holdout the
// registry nearly promoted — drew its candidates from TODAY'S index roster.
// For a 52-week-high strategy that is bias in the flattering direction
// twice over: names that later grew into the index were buyable before
// they joined, and names that died were never candidates at all.
//
// The engine now refuses to SCORE a name at a checkpoint where the mask
// says it was not a member — the same behaviour the live board produces,
// where the candidate pool simply is the current roster. That single rule
// yields both halves: no entries before joining, and (in topN mode) a
// rank-exit rotation when a holding is deleted, because a deleted name
// vanishes from the ranked board.

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

const up = (base: number, g = 1.002) => (i: number) =>
  base * Math.pow(g, i) * (1 + 0.006 * Math.sin(i / 3) + 0.004 * Math.sin(i / 7));

const START_BARS = '2016-01-04';
const N = 900;

function build(memberMask: (cpCount: number) => Record<string, boolean[] | undefined>,
               overrides: Partial<PolicyConfig> = {}): PolicyInputs {
  const spy = mkBars(START_BARS, N, up(400, 1.0005));
  const startDate = new Date(spy[400].t).toISOString().slice(0, 10);
  const endDate = new Date(spy[spy.length - 1].t).toISOString().slice(0, 10);
  const checkpoints = monthEndCheckpoints(spy, startDate, endDate);
  const masks = memberMask(checkpoints.length);
  const tickers: PolicyTickerData[] = [
    { ticker: 'ALWAYS', bars: mkBars(START_BARS, N, up(100)), memberAtCheckpoint: masks['ALWAYS'] },
    { ticker: 'LATECOMER', bars: mkBars(START_BARS, N, up(90, 1.0025)), memberAtCheckpoint: masks['LATECOMER'] },
  ];
  const config: PolicyConfig = {
    ...DEFAULT_POLICY_CONFIG,
    startDate, endDate,
    enterPctl: 0, exitPctl: 0, regimeMode: 'none',
    ...overrides,
  };
  return { tickers, spyBars: spy, checkpoints, config };
}

describe('policy-engine — PIT index membership', () => {
  it('never enters a name before it joined the index', () => {
    // LATECOMER joins at the midpoint; ALWAYS is a member throughout.
    let joinDate = '';
    const inputs = build((k) => {
      const half = Math.floor(k / 2);
      return {
        ALWAYS: new Array(k).fill(true),
        LATECOMER: Array.from({ length: k }, (_, i) => i >= half),
      };
    });
    joinDate = inputs.checkpoints[Math.floor(inputs.checkpoints.length / 2)];
    const res = runPolicyBacktest(inputs);
    const early = res.trades.filter((t) => t.ticker === 'LATECOMER' && t.entryDate < joinDate);
    expect(early).toHaveLength(0);
    // and it IS tradeable after joining — the mask gates, it does not ban
    expect(res.trades.some((t) => t.ticker === 'LATECOMER' && t.entryDate >= joinDate)).toBe(true);
  });

  it('topN mode rotates out a holding deleted from the index (as the live board would)', () => {
    // ALWAYS is deleted at the midpoint while its price keeps rising, so
    // nothing but membership can explain an exit.
    const inputs = build((k) => {
      const half = Math.floor(k / 2);
      return {
        ALWAYS: Array.from({ length: k }, (_, i) => i < half),
        LATECOMER: new Array(k).fill(true),
      };
    // maxHoldDays pushed out so the position is still OPEN at the deletion
    // checkpoint — with the default ~126d hold it exits days earlier on
    // max-hold and the rotation has nothing to rotate.
    }, { selectionMode: 'topN', topN: 2, maxHoldDays: 10_000 });
    const res = runPolicyBacktest(inputs);
    const exits = res.trades.filter((t) => t.ticker === 'ALWAYS' && t.exitReason === 'rank-exit');
    expect(exits.length).toBeGreaterThan(0);
  });

  it('no mask means membership unknown — everything stays tradeable (live windows)', () => {
    const inputs = build(() => ({ ALWAYS: undefined, LATECOMER: undefined }));
    const res = runPolicyBacktest(inputs);
    const entered = new Set(res.trades.map((t) => t.ticker));
    expect(entered.has('ALWAYS')).toBe(true);
    expect(entered.has('LATECOMER')).toBe(true);
  });
});
