// TRIDENT regime module — pins the design contract (design.md §3):
// trend gate is the ONLY hard gate; vol scaling continuous; overbought is
// display-only; crash-rebound suppresses breakouts; chop demotes them.

import { describe, it, expect } from 'vitest';
import { computeIndexRegime, rsiAt, type RegimeBar } from '../regime';

/** Synthetic daily bars from a close series (H/L hug close, volume flat). */
function mkBars(closes: number[], startDate = new Date(Date.UTC(2024, 0, 1))): RegimeBar[] {
  return closes.map((c, i) => {
    const d = new Date(startDate.getTime() + i * 86400000);
    return {
      date: d.toISOString().slice(0, 10),
      open: c * 0.999,
      high: c * 1.004,
      low: c * 0.996,
      close: c,
      volume: 1_000_000,
    };
  });
}

/** Steady geometric uptrend: dailyPct per bar. */
function trendCloses(n: number, start: number, dailyPct: number): number[] {
  const out: number[] = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    out.push(+p.toFixed(4));
    p *= 1 + dailyPct;
  }
  return out;
}

describe('computeIndexRegime', () => {
  it('steady uptrend → trend UP, entries allowed, NORMAL mix, no breakout demotion', () => {
    const r = computeIndexRegime('SPY', mkBars(trendCloses(320, 400, 0.001)));
    expect(r).not.toBeNull();
    expect(r!.trend.state).toBe('UP');
    expect(r!.modulation.entriesAllowed).toBe(true);
    expect(r!.modulation.entryMix).toBe('NORMAL');
    expect(r!.modulation.breakoutDemotion).toBe(0);
  });

  it('overbought label never gates: RSI14 > 70 in an uptrend still allows entries', () => {
    // Accelerating melt-up drives RSI high while trend stays UP.
    const closes = [...trendCloses(280, 400, 0.0005), ...trendCloses(40, 460, 0.008)];
    const r = computeIndexRegime('QQQ', mkBars(closes))!;
    expect(r.stretch.rsi14).toBeGreaterThan(70);
    expect(r.stretch.label).toBe('overbought');
    expect(r.modulation.entriesAllowed).toBe(true); // design.md §3.4
  });

  it('bear tape (below falling 200dma) → DOWN + hard entry gate', () => {
    const closes = [...trendCloses(200, 500, 0.0002), ...trendCloses(120, 500, -0.004)];
    const r = computeIndexRegime('SPY', mkBars(closes))!;
    expect(r.trend.state).toBe('DOWN');
    expect(r.modulation.entriesAllowed).toBe(false);
    expect(r.modulation.reasons.join(' ')).toMatch(/200dma/);
  });

  it('vol scaling is continuous and capped at 1', () => {
    const calm = computeIndexRegime('SPY', mkBars(trendCloses(320, 400, 0.0008)))!;
    expect(calm.modulation.sizeScalar).toBe(1); // tiny realized vol → capped

    // Alternating ±3% days → huge realized vol → scalar << 1
    const wild: number[] = [];
    let p = 400;
    for (let i = 0; i < 320; i++) {
      p *= i % 2 === 0 ? 1.03 : 0.97;
      wild.push(p);
    }
    const stormy = computeIndexRegime('SPY', mkBars(wild))!;
    expect(stormy.modulation.sizeScalar).toBeLessThan(0.5);
    expect(stormy.modulation.sizeScalar).toBeGreaterThan(0);
  });

  it('crash-rebound regime: deep recent drawdown + top-quintile vol → breakouts suppressed', () => {
    // 200 calm bars, then -30% crash over 40 bars with violent alternation, then sharp rebound.
    const calm = trendCloses(200, 500, 0.0005);
    const crash: number[] = [];
    let p = calm[calm.length - 1];
    for (let i = 0; i < 40; i++) {
      p *= i % 2 === 0 ? 0.955 : 1.02; // net drawdown with high vol
      crash.push(p);
    }
    const rebound: number[] = [];
    for (let i = 0; i < 30; i++) {
      p *= i % 2 === 0 ? 1.045 : 0.985; // violent V-bottom
      rebound.push(p);
    }
    const r = computeIndexRegime('QQQ', mkBars([...calm, ...crash, ...rebound]))!;
    expect(r.modulation.entryMix).toBe('CRASH_REBOUND');
    expect(r.modulation.breakoutDemotion).toBe(999);
  });

  it('emits sorted S/R levels incl. sma200, donchian bounds, round number', () => {
    const r = computeIndexRegime('SPY', mkBars(trendCloses(320, 400, 0.001)))!;
    const kinds = r.levels.map((l) => l.kind);
    expect(kinds).toContain('sma200');
    expect(kinds).toContain('donchian20High');
    expect(kinds).toContain('roundNumber');
    // sorted nearest-first
    const dists = r.levels.map((l) => Math.abs(l.distancePct));
    expect([...dists].sort((a, b) => a - b)).toEqual(dists);
  });

  it('returns null on insufficient history', () => {
    expect(computeIndexRegime('SPY', mkBars(trendCloses(30, 400, 0.001)))).toBeNull();
  });
});

describe('rsiAt', () => {
  it('is 100 when every bar rises and low when every bar falls', () => {
    const up = trendCloses(40, 100, 0.01);
    const dn = trendCloses(40, 100, -0.01);
    expect(rsiAt(up, 14, up.length - 1)).toBe(100);
    expect(rsiAt(dn, 14, dn.length - 1)).toBeLessThan(5);
  });
});
