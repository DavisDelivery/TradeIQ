import { describe, expect, it } from 'vitest';
import {
  deriveWilliamsSignal,
  computeATR,
  ATR_STOP_MULT,
  ATR_TARGET_MULT,
} from '../williams-signal';
import type { Bar } from '../../shared/data-provider';

function makeBars(n: number, basePrice = 100, dailyRange = 2): Bar[] {
  const bars: Bar[] = [];
  for (let i = 0; i < n; i++) {
    const c = basePrice + i * 0.1;
    bars.push({
      t: Date.UTC(2024, 0, i + 1),
      o: c - 0.2,
      h: c + dailyRange / 2,
      l: c - dailyRange / 2,
      c,
      v: 1_000_000,
    });
  }
  return bars;
}

describe('computeATR (Wilder)', () => {
  it('returns NaN when bars cannot fill the period', () => {
    const bars = makeBars(10);
    expect(Number.isNaN(computeATR(bars, 14))).toBe(true);
  });

  it('matches a hand-computed Wilder ATR on a constant-range tape', () => {
    // Constant true range of exactly 2 → ATR converges to 2.
    const bars = makeBars(30, 100, 2);
    const atr = computeATR(bars, 14);
    expect(atr).toBeGreaterThan(1.9);
    expect(atr).toBeLessThan(2.1);
  });

  it('rises when volatility expands', () => {
    const calm = makeBars(30, 100, 1);
    const wild = makeBars(30, 100, 5);
    expect(computeATR(wild, 14)).toBeGreaterThan(computeATR(calm, 14) * 2);
  });
});

describe('deriveWilliamsSignal — verdict from confluence', () => {
  it('emits BUY when %R turning + vol breakout + trend up + score ≥ 20', () => {
    const bars = makeBars(30, 100, 2);
    const sig = deriveWilliamsSignal(
      {
        score: 45,
        signals: {
          williamsR: -50,
          wrTurning: true,
          wrTopping: false,
          volBreakoutLong: true,
          volBreakoutShort: false,
          closeStrength10d: 70,
          uptrend: true,
          downtrend: false,
        },
      },
      bars,
    );
    expect(sig.verdict).toBe('BUY');
    expect(sig.entry).not.toBeNull();
    expect(sig.stop).not.toBeNull();
    expect(sig.target).not.toBeNull();
    // BUY stop is below entry; target above entry.
    expect(sig.stop!).toBeLessThan(sig.entry!);
    expect(sig.target!).toBeGreaterThan(sig.entry!);
    expect(sig.riskRewardRatio).toBe(ATR_TARGET_MULT);
  });

  it('emits SELL when %R topping + vol-short + downtrend + score ≤ −20', () => {
    const bars = makeBars(30, 100, 2);
    const sig = deriveWilliamsSignal(
      {
        score: -45,
        signals: {
          williamsR: -10,
          wrTurning: false,
          wrTopping: true,
          volBreakoutLong: false,
          volBreakoutShort: true,
          closeStrength10d: 25,
          uptrend: false,
          downtrend: true,
        },
      },
      bars,
    );
    expect(sig.verdict).toBe('SELL');
    expect(sig.stop!).toBeGreaterThan(sig.entry!);
    expect(sig.target!).toBeLessThan(sig.entry!);
  });

  it('HOLDs when score is high but confluence is missing', () => {
    const bars = makeBars(30, 100, 2);
    const sig = deriveWilliamsSignal(
      {
        score: 35,
        signals: {
          // Score is high from seasonality + trend, but %R is not turning
          // and no vol breakout — the BUY confluence rule should block.
          williamsR: -40,
          wrTurning: false,
          wrTopping: false,
          volBreakoutLong: false,
          volBreakoutShort: false,
          closeStrength10d: 50,
          uptrend: true,
          downtrend: false,
        },
      },
      bars,
    );
    expect(sig.verdict).toBe('HOLD');
    expect(sig.entry).toBeNull();
    expect(sig.stop).toBeNull();
    expect(sig.target).toBeNull();
  });

  it('HOLDs when score is below threshold even with full confluence', () => {
    const bars = makeBars(30, 100, 2);
    const sig = deriveWilliamsSignal(
      {
        score: 10,
        signals: {
          williamsR: -85,
          wrTurning: true,
          volBreakoutLong: true,
          closeStrength10d: 75,
          uptrend: true,
        },
      },
      bars,
    );
    expect(sig.verdict).toBe('HOLD');
  });

  it('refuses to BUY into a confirmed downtrend', () => {
    const bars = makeBars(30, 100, 2);
    const sig = deriveWilliamsSignal(
      {
        score: 45,
        signals: {
          williamsR: -85,
          wrTurning: true,
          volBreakoutLong: true,
          closeStrength10d: 75,
          uptrend: false,
          downtrend: true,
        },
      },
      bars,
    );
    expect(sig.verdict).toBe('HOLD');
  });

  it('returns HOLD with null levels when bars are too few for ATR', () => {
    const bars = makeBars(10, 100, 2);
    const sig = deriveWilliamsSignal(
      {
        score: 45,
        signals: { wrTurning: true, volBreakoutLong: true, uptrend: true },
      },
      bars,
    );
    expect(sig.verdict).toBe('HOLD');
    expect(sig.entry).toBeNull();
    expect(sig.atr).toBeNull();
  });

  it('stop sits ATR_STOP_MULT × ATR below entry on BUY', () => {
    const bars = makeBars(30, 100, 2);
    const atr = computeATR(bars, 14);
    const sig = deriveWilliamsSignal(
      {
        score: 45,
        signals: {
          williamsR: -85,
          wrTurning: true,
          volBreakoutLong: true,
          closeStrength10d: 75,
          uptrend: true,
        },
      },
      bars,
    );
    expect(sig.verdict).toBe('BUY');
    const expectedStop = sig.entry! - ATR_STOP_MULT * atr;
    expect(Math.abs(sig.stop! - expectedStop)).toBeLessThan(0.05);
  });
});
