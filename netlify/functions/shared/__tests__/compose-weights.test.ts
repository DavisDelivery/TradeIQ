// Phase 4f W3+W5 — composite reweight math tests.

import { describe, expect, it } from 'vitest';
import { composeWeights, provenanceFor } from '../compose-weights';

const TARGET_BASE = {
  'technical-analyst': 0.15,
  'sector-rotation': 0.08,
  'fundamental-analyst': 0.13,
  'flow-analyst': 0.10,
  'news-sentiment': 0.10,
  'earnings-analyst': 0.07,
  'macro-regime': 0.07,
  'insider-analyst': 0.14,
  'patent-analyst': 0.06,
  'political-analyst': 0.10,
};

describe('composeWeights', () => {
  it('no exclusions → effective weights match base', () => {
    const r = composeWeights({
      noDataByAnalyst: {},
      baseWeights: TARGET_BASE,
    });
    expect(r.rescaled).toBe(false);
    expect(r.noDataAnalysts).toEqual([]);
    expect(r.scoredAnalysts).toHaveLength(10);
    for (const [name, w] of Object.entries(TARGET_BASE)) {
      expect(r.effectiveWeights[name]).toBeCloseTo(w, 6);
    }
  });

  it('one exclusion → freed weight redistributed proportionally', () => {
    // Drop insider (0.14). Remaining baseline weights sum = 0.86.
    // Each survivor gets its own_weight / 0.86.
    const r = composeWeights({
      noDataByAnalyst: { 'insider-analyst': true },
      baseWeights: TARGET_BASE,
    });
    expect(r.rescaled).toBe(true);
    expect(r.noDataAnalysts).toEqual(['insider-analyst']);
    expect(r.effectiveWeights['insider-analyst']).toBe(0);
    expect(r.effectiveWeights['technical-analyst']).toBeCloseTo(0.15 / 0.86, 6);
    expect(r.effectiveWeights['fundamental-analyst']).toBeCloseTo(0.13 / 0.86, 6);
    // Verify survivors sum to 1.0.
    const surviving = Object.entries(r.effectiveWeights)
      .filter(([k]) => k !== 'insider-analyst')
      .reduce((s, [, v]) => s + v, 0);
    expect(surviving).toBeCloseTo(1.0, 6);
  });

  it('five exclusions (Chad screenshot scenario) → 5 survivors sum to 1.0', () => {
    const r = composeWeights({
      noDataByAnalyst: {
        'insider-analyst': true,
        'political-analyst': true,
        'macro-regime': true,
        'earnings-analyst': true,
        'patent-analyst': true,
      },
      baseWeights: TARGET_BASE,
    });
    expect(r.scoredAnalysts).toHaveLength(5);
    expect(r.noDataAnalysts).toHaveLength(5);
    const liveSum = r.scoredAnalysts.reduce(
      (s, n) => s + r.effectiveWeights[n],
      0,
    );
    expect(liveSum).toBeCloseTo(1.0, 6);
    // The dead analysts' effective weight is 0.
    for (const n of r.noDataAnalysts) {
      expect(r.effectiveWeights[n]).toBe(0);
    }
  });

  it('all-no-data → every effective weight 0, scoredAnalysts empty', () => {
    const noDataByAnalyst: Record<string, boolean> = {};
    for (const k of Object.keys(TARGET_BASE)) noDataByAnalyst[k] = true;
    const r = composeWeights({ noDataByAnalyst, baseWeights: TARGET_BASE });
    expect(r.scoredAnalysts).toEqual([]);
    for (const w of Object.values(r.effectiveWeights)) expect(w).toBe(0);
  });

  it('preserves proportionality regardless of which are removed', () => {
    // Drop fundamental (0.13) and earnings (0.07). Remaining sum = 0.80.
    const r = composeWeights({
      noDataByAnalyst: {
        'fundamental-analyst': true,
        'earnings-analyst': true,
      },
      baseWeights: TARGET_BASE,
    });
    expect(r.effectiveWeights['technical-analyst']).toBeCloseTo(0.15 / 0.80, 6);
    expect(r.effectiveWeights['insider-analyst']).toBeCloseTo(0.14 / 0.80, 6);
    // Ratio between technical and insider survives the rescale.
    expect(
      r.effectiveWeights['technical-analyst'] /
        r.effectiveWeights['insider-analyst'],
    ).toBeCloseTo(0.15 / 0.14, 6);
  });
});

describe('provenanceFor', () => {
  const baseline = composeWeights({
    noDataByAnalyst: { 'insider-analyst': true },
    baseWeights: TARGET_BASE,
  });
  const permanentlyRemoved = new Set(['patent-analyst']);

  it('returns "no_data" for an excluded analyst', () => {
    expect(provenanceFor('insider-analyst', baseline)).toBe('no_data');
  });
  it('returns "removed" for a permanently-removed analyst', () => {
    expect(provenanceFor('patent-analyst', baseline, permanentlyRemoved)).toBe(
      'removed',
    );
  });
  it('returns "live" for a scored analyst', () => {
    expect(provenanceFor('technical-analyst', baseline)).toBe('live');
  });
});
