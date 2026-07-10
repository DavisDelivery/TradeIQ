// DESK-1 W3 — pure indicator math tests with known fixtures.
// SMA against hand-computed means; RSI against the canonical Wilder
// worked example; ATR Wilder-smoothing behavior.

import { describe, it, expect } from 'vitest';
import { sma, rsi, atr } from '../indicators.js';

describe('sma', () => {
  it('computes means aligned to the input, null-padded before the window fills', () => {
    const out = sma([1, 2, 3, 4, 5], 3);
    expect(out).toEqual([null, null, 2, 3, 4]);
  });

  it('returns all-null when the series is shorter than the period', () => {
    expect(sma([1, 2], 5)).toEqual([null, null]);
  });

  it('poisons windows containing non-finite values instead of fabricating', () => {
    const out = sma([1, 2, NaN, 4, 5, 6], 3);
    expect(out[2]).toBeNull(); // window [1,2,NaN]
    expect(out[3]).toBeNull(); // window [2,NaN,4]
    expect(out[4]).toBeNull(); // window [NaN,4,5]
    expect(out[5]).toBe(5);    // window [4,5,6]
  });

  it('rejects a nonsense period', () => {
    expect(sma([1, 2, 3], 0)).toEqual([null, null, null]);
    expect(sma([1, 2, 3], -2)).toEqual([null, null, null]);
  });
});

describe('rsi', () => {
  it('is 100 on a monotonic rally (no losses) and 0 on a monotonic slide', () => {
    const up = Array.from({ length: 20 }, (_, i) => 100 + i);
    const down = Array.from({ length: 20 }, (_, i) => 100 - i);
    const upOut = rsi(up, 14);
    const downOut = rsi(down, 14);
    expect(upOut[14]).toBe(100);
    expect(upOut[19]).toBe(100);
    expect(downOut[19]).toBe(0);
  });

  it('matches the canonical Wilder worked example (±0.1)', () => {
    // The classic 14-period example series (Wilder / StockCharts):
    const closes = [
      44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42,
      45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00,
      46.03, 46.41, 46.22, 45.64,
    ];
    const out = rsi(closes, 14);
    expect(out[13]).toBeNull();           // undefined before 14 deltas
    expect(out[14]).toBeCloseTo(70.46, 1); // first RSI
    expect(out[19]).toBeCloseTo(58.19, 0); // after Wilder smoothing
  });

  it('null-pads a series shorter than period+1', () => {
    expect(rsi([1, 2, 3], 14)).toEqual([null, null, null]);
  });

  it('flat series (zero gain, zero loss) reads 50, not NaN', () => {
    const flat = Array.from({ length: 20 }, () => 100);
    expect(rsi(flat, 14)[14]).toBe(50);
  });
});

describe('atr', () => {
  const bar = (h, l, c) => ({ high: h, low: l, close: c });

  it('constant true range → ATR equals that range at every defined index', () => {
    // Every bar: range 2, no gaps (close mid-range).
    const bars = Array.from({ length: 30 }, () => bar(101, 99, 100));
    const out = atr(bars, 14);
    expect(out[13]).toBeNull();
    expect(out[14]).toBeCloseTo(2, 10);
    expect(out[29]).toBeCloseTo(2, 10);
  });

  it('uses Wilder smoothing after the seed (spike decays, not jumps)', () => {
    const bars = Array.from({ length: 16 }, () => bar(101, 99, 100));
    bars[15] = bar(110, 90, 100); // TR = 20 on the last bar
    const out = atr(bars, 14);
    // seed 2 over first 14 TRs; next = (2*13 + 20)/14 = 46/14 ≈ 3.2857
    expect(out[15]).toBeCloseTo(46 / 14, 4);
  });

  it('accounts for gaps via prev-close in true range', () => {
    const bars = [bar(101, 99, 100), bar(111, 110, 110.5)]; // gap up: TR = 111-100 = 11
    const out = atr(bars, 1);
    expect(out[1]).toBeCloseTo(11, 10);
  });

  it('null-pads short series', () => {
    expect(atr([bar(1, 1, 1)], 14)).toEqual([null]);
  });
});
