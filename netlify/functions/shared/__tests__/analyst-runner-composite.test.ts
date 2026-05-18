// Phase 4s — regression tests for the directional, conflict-aware
// composite. Anchored on the O-I Glass profile Chad surfaced: 5/7
// analysts bearish on the name, 1 strongly bullish. The pre-4s code
// scored this 92/A/LONG because the `Math.abs(signedNet)` composite
// and the `direction==='short' ? -(score-50)` signed formula together
// produced a magnitude composite with bearish analysts flipped to push
// bullish. The post-4s composite is directional + conflict-aware.

import { describe, expect, it } from 'vitest';
import { composeTarget } from '../analyst-runner';
import type { AnalystOutput, Direction } from '../types';

// The live production weight map from analyst-runner.ts. Re-stated here
// so the tests assert against the same numbers the runner uses.
const LIVE_WEIGHTS: Record<string, number> = {
  'technical-analyst': 0.15,
  'sector-rotation': 0.08,
  'fundamental-analyst': 0.13,
  'flow-analyst': 0.10,
  'news-sentiment': 0.10,
  'earnings-analyst': 0.07,
  'macro-regime': 0,
  'insider-analyst': 0.14,
  'patent-analyst': 0,
  'political-analyst': 0.10,
};

interface MockOpts {
  score: number;
  direction: Direction;
  confidence?: number;
  noData?: boolean;
}

function mock(opts: MockOpts): AnalystOutput {
  return {
    score: opts.score,
    direction: opts.direction,
    confidence: opts.confidence ?? 0.7,
    rationale: 'test',
    signals: opts.noData ? { _noData: true, _reason: 'test' } : {},
  };
}

// Builds a full 10-analyst record with defaults; callers override what
// they want to flex. Defaults are coherent-neutral with no-data on the
// pinned-zero analysts (patent, macro) so the live weight map sums to
// the same total as in production.
function buildAnalysts(overrides: Partial<Record<string, AnalystOutput>>): Record<string, AnalystOutput> {
  return {
    'technical-analyst': mock({ score: 50, direction: 'neutral' }),
    'sector-rotation': mock({ score: 50, direction: 'neutral' }),
    'fundamental-analyst': mock({ score: 50, direction: 'neutral' }),
    'flow-analyst': mock({ score: 50, direction: 'neutral' }),
    'news-sentiment': mock({ score: 50, direction: 'neutral' }),
    'earnings-analyst': mock({ score: 50, direction: 'neutral', noData: true }),
    'macro-regime': mock({ score: 50, direction: 'neutral', noData: true }),
    'insider-analyst': mock({ score: 50, direction: 'neutral' }),
    'patent-analyst': mock({ score: 50, direction: 'neutral', noData: true }),
    'political-analyst': mock({ score: 50, direction: 'neutral' }),
    ...overrides,
  };
}

describe('composeTarget — Phase 4s directional composite', () => {
  // The headline regression. This is the exact OI profile Chad reported:
  //   Technical 28 (red), Sector 16 (red), Fundamental 28 (red),
  //   Flow 45 (red-ish), News 28 (red), Insider 100 (green).
  // Pre-4s output: composite 92, tier A, direction LONG.
  // Post-4s requirement: composite < 50, tier ≠ A, direction ≠ long.
  it('O-I Glass profile (5 bearish + 1 strongly bullish) is bearish, not A/LONG', () => {
    const analysts = buildAnalysts({
      'technical-analyst':    mock({ score: 28,  direction: 'short' }),
      'sector-rotation':      mock({ score: 16,  direction: 'short' }),
      'fundamental-analyst':  mock({ score: 28,  direction: 'short' }),
      'flow-analyst':         mock({ score: 45,  direction: 'short' }),
      'news-sentiment':       mock({ score: 28,  direction: 'short' }),
      'insider-analyst':      mock({ score: 100, direction: 'long' }),
      'political-analyst':    mock({ score: 50,  direction: 'neutral', noData: true }),
    });

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    // Acceptance criteria 1 from the brief:
    expect(r.composite).toBeLessThan(50);
    expect(r.tier).not.toBe('A');
    expect(r.direction).not.toBe('long');
    // And the corollary — it's actually a short:
    expect(r.direction).toBe('short');
  });

  it('coherently bullish profile → high composite, tier A, direction long', () => {
    const analysts = buildAnalysts({
      'technical-analyst':    mock({ score: 90, direction: 'long', confidence: 0.9 }),
      'sector-rotation':      mock({ score: 80, direction: 'long', confidence: 0.8 }),
      'fundamental-analyst':  mock({ score: 85, direction: 'long', confidence: 0.9 }),
      'flow-analyst':         mock({ score: 85, direction: 'long', confidence: 0.8 }),
      'news-sentiment':       mock({ score: 80, direction: 'long', confidence: 0.8 }),
      'insider-analyst':      mock({ score: 90, direction: 'long', confidence: 0.9 }),
      'political-analyst':    mock({ score: 75, direction: 'long', confidence: 0.7 }),
    });

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    expect(r.composite).toBeGreaterThanOrEqual(85);
    expect(r.tier).toBe('A');
    expect(r.direction).toBe('long');
    expect(r.conflictLevel).toBe('none');
  });

  it('coherently bearish profile → low composite, tier ≠ A, direction short', () => {
    const analysts = buildAnalysts({
      'technical-analyst':    mock({ score: 10, direction: 'short', confidence: 0.9 }),
      'sector-rotation':      mock({ score: 20, direction: 'short', confidence: 0.8 }),
      'fundamental-analyst':  mock({ score: 15, direction: 'short', confidence: 0.9 }),
      'flow-analyst':         mock({ score: 20, direction: 'short', confidence: 0.8 }),
      'news-sentiment':       mock({ score: 25, direction: 'short', confidence: 0.8 }),
      'insider-analyst':      mock({ score: 15, direction: 'short', confidence: 0.7 }),
      'political-analyst':    mock({ score: 20, direction: 'short', confidence: 0.7 }),
    });

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    expect(r.composite).toBeLessThan(20);
    expect(r.tier).not.toBe('A');
    expect(r.direction).toBe('short');
    expect(r.conflictLevel).toBe('none');
  });

  it('genuinely neutral profile (all ≈ 50) → composite near 50', () => {
    // All analysts hover within ±3 of neutral with moderate confidence.
    const analysts = buildAnalysts({
      'technical-analyst':    mock({ score: 52, direction: 'neutral', confidence: 0.4 }),
      'sector-rotation':      mock({ score: 48, direction: 'neutral', confidence: 0.4 }),
      'fundamental-analyst':  mock({ score: 51, direction: 'neutral', confidence: 0.4 }),
      'flow-analyst':         mock({ score: 49, direction: 'neutral', confidence: 0.4 }),
      'news-sentiment':       mock({ score: 50, direction: 'neutral', confidence: 0.4 }),
      'insider-analyst':      mock({ score: 50, direction: 'neutral', confidence: 0.4 }),
      'political-analyst':    mock({ score: 50, direction: 'neutral', confidence: 0.4 }),
    });

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    expect(r.composite).toBeGreaterThanOrEqual(45);
    expect(r.composite).toBeLessThanOrEqual(55);
    expect(r.direction).toBe('neutral');
  });

  // Severe conflict: 3 strong bulls + 3 strong bears, all confident.
  // Without conflict treatment they'd cancel out and the composite would
  // sit near 50 anyway. The dampening factor and tier cap kick in to
  // ensure a high-magnitude *and* high-disagreement scenario can't grade
  // A even if one side edges out — see "moderate conflict" test below
  // for the magnitude-bearing variant.
  it('severe-conflict profile (3 bullish + 3 bearish strong) → conflict severe, tier capped at C', () => {
    const analysts = buildAnalysts({
      'technical-analyst':    mock({ score: 80, direction: 'long',  confidence: 0.9 }),
      'fundamental-analyst':  mock({ score: 85, direction: 'long',  confidence: 0.9 }),
      'insider-analyst':      mock({ score: 90, direction: 'long',  confidence: 0.9 }),
      'sector-rotation':      mock({ score: 20, direction: 'short', confidence: 0.9 }),
      'flow-analyst':         mock({ score: 15, direction: 'short', confidence: 0.9 }),
      'news-sentiment':       mock({ score: 20, direction: 'short', confidence: 0.9 }),
      'political-analyst':    mock({ score: 50, direction: 'neutral', confidence: 0.4 }),
    });

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    expect(r.conflictLevel).toBe('severe');
    // Tier cap: severe → max C, regardless of where composite lands.
    expect(r.tier).toBe('C');
  });

  // Moderate conflict + would-otherwise-be-A profile: a coherent strong
  // bull setup with two bearish dissenters. Tier must cap at B and the
  // composite must dampen toward 50 vs the un-dampened equivalent.
  it('moderate-conflict bullish profile → tier capped at B, composite dampened', () => {
    const bullishOverrides = {
      'technical-analyst':    mock({ score: 95, direction: 'long', confidence: 0.95 }),
      'sector-rotation':      mock({ score: 90, direction: 'long', confidence: 0.9 }),
      'fundamental-analyst':  mock({ score: 90, direction: 'long', confidence: 0.95 }),
      'flow-analyst':         mock({ score: 25, direction: 'short', confidence: 0.9 }),
      'news-sentiment':       mock({ score: 20, direction: 'short', confidence: 0.85 }),
      'insider-analyst':      mock({ score: 90, direction: 'long', confidence: 0.95 }),
      'political-analyst':    mock({ score: 80, direction: 'long', confidence: 0.7 }),
    };
    const analysts = buildAnalysts(bullishOverrides);

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    // 2 disagreers (flow, news) → moderate. Tier cap is B.
    expect(r.conflictLevel).toBe('moderate');
    expect(r.tier).toBe('B');
    expect(r.direction).toBe('long');

    // Dampening sanity check: same profile with all dissenters removed
    // (replaced with neutral no-data) must produce a STRICTLY higher
    // composite than the moderate-conflict version — confirms the
    // dampening factor actually pulls the score toward 50.
    const noConflict = buildAnalysts({
      ...bullishOverrides,
      'flow-analyst':   mock({ score: 50, direction: 'neutral', noData: true }),
      'news-sentiment': mock({ score: 50, direction: 'neutral', noData: true }),
    });
    const rNoConflict = composeTarget(noConflict, LIVE_WEIGHTS);
    expect(rNoConflict.composite).toBeGreaterThan(r.composite);
  });

  it('Math.abs regression — magnitude-only scoring would have rated OI > 80; now strictly bearish', () => {
    // Concrete check that the prior bug shape is gone: an OI-like
    // profile with the dial cranked (deeply bearish analysts + a
    // strong bullish outlier) cannot produce a composite above 50.
    const analysts = buildAnalysts({
      'technical-analyst':    mock({ score: 20, direction: 'short', confidence: 0.9 }),
      'sector-rotation':      mock({ score: 10, direction: 'short', confidence: 0.9 }),
      'fundamental-analyst':  mock({ score: 20, direction: 'short', confidence: 0.9 }),
      'flow-analyst':         mock({ score: 40, direction: 'short', confidence: 0.8 }),
      'news-sentiment':       mock({ score: 20, direction: 'short', confidence: 0.9 }),
      'insider-analyst':      mock({ score: 100, direction: 'long', confidence: 0.95 }),
      'political-analyst':    mock({ score: 50, direction: 'neutral', confidence: 0.3 }),
    });

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    expect(r.signedNet).toBeLessThan(0);
    expect(r.composite).toBeLessThan(50);
    expect(r.tier).not.toBe('A');
  });

  it('no-data analysts are excluded — composite weights rescale to survivors', () => {
    const analysts = buildAnalysts({
      // 4 of the 10 are no-data; the other 6 are coherently bullish.
      'technical-analyst':    mock({ score: 85, direction: 'long', confidence: 0.9 }),
      'sector-rotation':      mock({ score: 80, direction: 'long', confidence: 0.8 }),
      'fundamental-analyst':  mock({ score: 90, direction: 'long', confidence: 0.9 }),
      'flow-analyst':         mock({ score: 50, direction: 'neutral', noData: true }),
      'news-sentiment':       mock({ score: 50, direction: 'neutral', noData: true }),
      'insider-analyst':      mock({ score: 85, direction: 'long', confidence: 0.9 }),
      'political-analyst':    mock({ score: 80, direction: 'long', confidence: 0.7 }),
    });

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    expect(r.direction).toBe('long');
    expect(r.composite).toBeGreaterThan(75);
    expect(r.noDataAnalysts).toContain('flow-analyst');
    expect(r.noDataAnalysts).toContain('news-sentiment');
    expect(r.scoredAnalysts).not.toContain('flow-analyst');
  });

  it('all analysts no-data → signedNet 0, composite 50, direction neutral', () => {
    const analysts: Record<string, AnalystOutput> = {};
    for (const name of Object.keys(LIVE_WEIGHTS)) {
      analysts[name] = mock({ score: 50, direction: 'neutral', noData: true });
    }
    const r = composeTarget(analysts, LIVE_WEIGHTS);
    expect(r.signedNet).toBe(0);
    expect(r.composite).toBe(50);
    expect(r.direction).toBe('neutral');
  });
});
