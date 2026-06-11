// CR-4 regression — runTechnical's ema() used to fall back to `xs.at(-1)`
// when bars < period. The standard 220-calendar-day fetch yields ~150
// trading bars, so ema200 silently became the latest close and the trend
// term `ema50 > ema200` turned into `ema50 > price` — +10 when price was
// BELOW its 50-EMA, −10 when above (sign-inverted on every live scan).
// Post-fix: ema() returns null on insufficient data and the trend term
// (and the uptrend/downtrend rationale) is skipped entirely.
//
// Also covers the adjacent minor [m1]: bbPos divided by (upper − mid) = 2σ,
// so a flat tape (σ = 0) produced 0/0 = NaN in signals.bbPosition.

import { describe, expect, it } from 'vitest';
import { runTechnical } from '../technical';
import type { Bar } from '../../shared/data-provider';

function mkBars(closes: number[], vol = 1_000_000): Bar[] {
  return closes.map((c, i) => ({ t: i * 86_400_000, o: c, h: c, l: c, c, v: vol }));
}

function linear(from: number, to: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1));
}

describe('runTechnical — CR-4 ema null-discipline', () => {
  it('ema200 is null (not the latest close) when bars < 200', () => {
    const r = runTechnical(mkBars(linear(100, 200, 150)));
    // Pre-fix this was the latest close (200) — the degenerate fallback.
    expect(r.signals.ema200).toBeNull();
    expect(r.signals.ema20).not.toBeNull();
    expect(r.signals.ema50).not.toBeNull();
  });

  it('150-bar uptrend is not penalized by the sign-inverted trend term', () => {
    // Steady uptrend on ~150 bars: latest > ema20 > ema50, positive ROC.
    // Pre-fix the trend term compared ema50 against the LATEST CLOSE
    // (ema50 < latest in an uptrend → −10 raw, score 5 points lower).
    // Post-fix the term is skipped: raw ≈ 15 + 10 + roc terms ≈ 45 → ~73.
    const r = runTechnical(mkBars(linear(100, 200, 150)));
    expect(r.direction).toBe('long');
    expect(r.score).toBeGreaterThanOrEqual(70);
  });

  it('150-bar downtrend gets no bullish credit from the inverted term', () => {
    // Mirror case: pre-fix a downtrend earned +10 raw because ema50 sat
    // ABOVE the latest close. Post-fix the term is skipped.
    const r = runTechnical(mkBars(linear(200, 100, 150)));
    expect(r.direction).toBe('short');
    expect(r.score).toBeLessThanOrEqual(30);
    expect(r.rationale).not.toContain('uptrend intact');
  });

  it('"uptrend intact" rationale requires a real ema200 (250-bar uptrend)', () => {
    const r = runTechnical(mkBars(linear(100, 250, 250)));
    expect(r.signals.ema200).not.toBeNull();
    expect(r.rationale).toContain('uptrend intact');
  });

  it('no trend rationale claim either way when ema200 is unavailable', () => {
    const r = runTechnical(mkBars(linear(100, 200, 150)));
    expect(r.rationale).not.toContain('uptrend intact');
  });
});

describe('runTechnical — flat-tape bbPos guard [m1]', () => {
  it('σ=0 tape yields bbPosition 0 (neutral), not NaN, and a finite score', () => {
    const r = runTechnical(mkBars(Array(150).fill(100)));
    expect(r.signals.bbPosition).toBe(0);
    expect(Number.isFinite(r.score)).toBe(true);
  });
});
