// 4c-2 Stage 1 signal tests. The five signals are pure functions over
// bars, so we exercise them with hand-built synthetic series and check
// the directional/threshold behavior. The percentile-ranking step is
// covered indirectly via the orchestrator test if we add one — here we
// just pin the raw signal contract.

import { describe, it, expect } from 'vitest';
import { computeRawSignals } from '../stage1';
import type { Bar } from '../../data-provider';

function makeBars(closes: number[], volume = 1_000_000): Bar[] {
  const out: Bar[] = [];
  const startMs = new Date('2024-01-02').getTime();
  for (let i = 0; i < closes.length; i++) {
    out.push({
      t: startMs + i * 86_400_000,
      o: closes[i],
      h: closes[i],
      l: closes[i],
      c: closes[i],
      v: volume,
    } as Bar);
  }
  return out;
}

describe('computeRawSignals — preconditions', () => {
  it('returns null when fewer than 200 bars', () => {
    const bars = makeBars([1, 2, 3]);
    expect(computeRawSignals('TEST', bars)).toBeNull();
  });
});

describe('computeRawSignals — trend qualifier', () => {
  it('returns true when close above sma20, sma50, sma200', () => {
    // 200 bars at $100, then 5 bars at $120 — the last $120 lifts all
    // SMAs but stays above each.
    const closes = Array(200).fill(100).concat([120, 120, 120, 120, 120]);
    const sig = computeRawSignals('TEST', makeBars(closes));
    expect(sig).not.toBeNull();
    expect(sig!.trendQualifier).toBe(true);
  });

  it('returns false when close below sma50', () => {
    // Climb then crash below SMA50 baseline.
    const closes = Array(200).fill(100).concat(Array(50).fill(120)).concat([80]);
    const sig = computeRawSignals('TEST', makeBars(closes));
    expect(sig!.trendQualifier).toBe(false);
  });
});

describe('computeRawSignals — momentum 20d', () => {
  it('returns positive momentum on an uptrend', () => {
    const closes = Array.from({ length: 260 }, (_, i) => 100 + i * 0.1);
    const sig = computeRawSignals('TEST', makeBars(closes));
    expect(sig!.momentum20d).toBeGreaterThan(0);
  });

  it('returns negative momentum on a downtrend', () => {
    const closes = Array.from({ length: 260 }, (_, i) => 200 - i * 0.1);
    const sig = computeRawSignals('TEST', makeBars(closes));
    expect(sig!.momentum20d).toBeLessThan(0);
  });
});

describe('computeRawSignals — volume surge', () => {
  it('returns ~1.0 with flat volume', () => {
    const closes = Array(260).fill(100);
    const bars = makeBars(closes, 1_000_000);
    const sig = computeRawSignals('TEST', bars);
    expect(sig!.volumeSurge).toBeCloseTo(1.0, 1);
  });

  it('returns >1.5 when last 5 days volume spike', () => {
    const closes = Array(260).fill(100);
    const bars = makeBars(closes, 1_000_000);
    // Spike volume on the last 5 bars
    for (let i = bars.length - 5; i < bars.length; i++) bars[i].v = 3_000_000;
    const sig = computeRawSignals('TEST', bars);
    expect(sig!.volumeSurge).toBeGreaterThan(1.5);
  });
});

describe('computeRawSignals — above 52w low margin', () => {
  it('returns positive margin when price is above its 52w low', () => {
    // 252 bars starting at $50, ending at $100 — 100% margin above low
    const closes = Array.from({ length: 260 }, (_, i) => 50 + i * 0.2);
    const sig = computeRawSignals('TEST', makeBars(closes));
    expect(sig!.above52wLowPct).toBeGreaterThan(0.5);
  });

  it('returns near-zero margin when at the 52w low', () => {
    // Mostly $100, dip to $50 just before the end.
    const closes = Array(255).fill(100).concat([50]);
    const sig = computeRawSignals('TEST', makeBars(closes));
    expect(sig!.above52wLowPct).toBeLessThan(0.01);
  });
});
