// Wave 4C (code-review-2026-06 track-1, M5) — Lynch PEG growth input.
//
// The bug: PEG was computed from `epsGrowthYoY` = latest quarter vs
// year-ago quarter. A base-effect rebound (+300% off a depressed comp)
// produced PEG ≈ 0 → an automatic "+40 cheap for growth" — and the
// fair-value band implied a "fair" P/E of 300-450.
//
// The fix pinned here:
//   1. runLynch consumes TTM-vs-prior-TTM growth (`epsGrowthTTM`).
//   2. The growth rate is CLAMPED to [LYNCH_GROWTH_MIN_PCT,
//      LYNCH_GROWTH_MAX_PCT] (10-40%) before touching PEG.
//   3. deriveLynchSignal clamps the same way before deriving the
//      fair-P/E band.
//
// Fail-then-pass evidence: the band test below ("caps the fair-P/E …")
// and the scenario test were run against the pre-fix sources (sources
// stashed, tests kept) and failed as expected — see the Wave 4C PR body.

import { describe, expect, it } from 'vitest';
import {
  runLynch,
  LYNCH_GROWTH_MIN_PCT,
  LYNCH_GROWTH_MAX_PCT,
} from '../lynch';
import { deriveLynchSignal, deriveLynchSignalFromAnalyst } from '../lynch-signal';

describe('runLynch — TTM growth basis for PEG (M5)', () => {
  it('base-effect rebound: quarterly EPS +300% but TTM growth ~12% — PEG uses the TTM rate', () => {
    // Pre-fix, this company's single-quarter rebound (+300%) yielded
    // PEG = 30 / 300 = 0.10 → "+40 cheap for growth". Its sustainable
    // TTM-on-TTM growth is 12%, so the honest PEG is 30 / 12 = 2.5 —
    // "priced for perfection".
    const s = runLynch({
      ticker: 'REBOUND',
      peRatio: 30,
      epsGrowthTTM: 0.12, // TTM vs prior TTM — within the clamp range
    });
    expect(s.signals.peg).toBeCloseTo(30 / 12, 2);
    expect(s.signals.pegGrowthPct).toBeCloseTo(12, 5);
    expect(s.signals.growthClamped).toBeUndefined();
    expect(s.rationale).toMatch(/priced for perfection/);
    expect(s.score).toBeLessThan(0); // −25 PEG penalty, nothing else scored
  });

  it('clamps hypergrowth TTM rates to LYNCH_GROWTH_MAX_PCT for PEG', () => {
    // Even a genuine +300% TTM rate is not a sustainable Lynch growth
    // rate. PEG must use the 40% ceiling: 30 / 40 = 0.75 ("reasonable"),
    // not 30 / 300 = 0.10 ("cheap for growth").
    const s = runLynch({
      ticker: 'HYPER',
      peRatio: 30,
      epsGrowthTTM: 3.0,
    });
    expect(s.signals.pegGrowthPct).toBe(LYNCH_GROWTH_MAX_PCT);
    expect(s.signals.peg).toBeCloseTo(0.75, 2);
    expect(s.signals.growthClamped).toBe(true);
    // Raw rate still surfaced for display/history.
    expect(s.signals.epsGrowthYoYPct).toBeCloseTo(300, 1);
    expect(s.rationale).toMatch(/reasonable/);
  });

  it('clamps sub-10% growth up to LYNCH_GROWTH_MIN_PCT (slow growers are not Lynch candidates)', () => {
    const s = runLynch({
      ticker: 'SLOW',
      peRatio: 30,
      epsGrowthTTM: 0.02,
    });
    expect(s.signals.pegGrowthPct).toBe(LYNCH_GROWTH_MIN_PCT);
    expect(s.signals.peg).toBeCloseTo(3.0, 2);
    expect(s.signals.growthClamped).toBe(true);
  });

  it('confidence credits the TTM growth input', () => {
    const withGrowth = runLynch({ ticker: 'A', peRatio: 20, epsGrowthTTM: 0.2 });
    const withoutGrowth = runLynch({ ticker: 'A', peRatio: 20 });
    expect(withGrowth.confidence).toBeCloseTo(withoutGrowth.confidence + 0.25, 5);
  });
});

describe('deriveLynchSignal — fair-P/E band clamp (M5)', () => {
  it('caps the fair-P/E band at LYNCH_GROWTH_MAX_PCT — no more fair P/E of 300', () => {
    // Pre-fix: growth 300% → fairValueLow = 1 × 300 = 300 and
    // fairValueHigh = 1 × 450. Post-fix the band is 40-60.
    const sig = deriveLynchSignal({
      score: 10,
      peg: 2.5,
      epsGrowthYoYPct: 300,
      ttmEps: 1,
    });
    expect(sig.fairValueLow).toBeCloseTo(LYNCH_GROWTH_MAX_PCT * 1, 2); // 40
    expect(sig.fairValueHigh).toBeCloseTo(LYNCH_GROWTH_MAX_PCT * 1.5, 2); // 60
  });

  it('floors the fair-P/E band at LYNCH_GROWTH_MIN_PCT', () => {
    const sig = deriveLynchSignal({
      score: 10,
      peg: 1.2,
      epsGrowthYoYPct: 4,
      ttmEps: 2,
    });
    expect(sig.fairValueLow).toBeCloseTo(LYNCH_GROWTH_MIN_PCT * 2, 2); // 20
    expect(sig.fairValueHigh).toBeCloseTo(LYNCH_GROWTH_MIN_PCT * 2 * 1.5, 2); // 30
  });

  it('leaves in-range growth untouched (existing 20%-growth contract)', () => {
    const sig = deriveLynchSignal({
      score: 60,
      peg: 0.8,
      epsGrowthYoYPct: 20,
      ttmEps: 5,
    });
    expect(sig.fairValueLow).toBeCloseTo(100, 0);
    expect(sig.fairValueHigh).toBeCloseTo(150, 0);
  });

  it('end-to-end: runLynch signals → deriveLynchSignalFromAnalyst gives a sane band on a base-effect name', () => {
    const s = runLynch({ ticker: 'HYPER', peRatio: 30, epsGrowthTTM: 3.0 });
    const sig = deriveLynchSignalFromAnalyst(
      { score: s.score, signals: s.signals },
      { currentPrice: 60, ttmEps: 2 },
    );
    // Band derives from the clamped 40%: 2×40=80 .. 2×60=120.
    expect(sig.fairValueLow).toBeCloseTo(80, 1);
    expect(sig.fairValueHigh).toBeCloseTo(120, 1);
  });
});
