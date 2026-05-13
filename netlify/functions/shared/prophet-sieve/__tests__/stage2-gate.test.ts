// 4c-2 Stage 2 earnings-quality gate contract.
//
// The gate is the load-bearing piece of Chad's product priority: a ticker
// must clear it to reach Stage 3 (full 7-layer scoring). Lenient on
// missing data; strict on clearly weak signal sets.

import { describe, it, expect } from 'vitest';
import { computeStage2Gate } from '../stage2';

describe('computeStage2Gate — hard stop', () => {
  it('rejects severe EPS contraction regardless of other signals', () => {
    const result = computeStage2Gate({
      eps: -0.20,
      operatingMarginTrendPp: 5,  // would normally rescue
      peExpansion: 0.30,           // would normally rescue
      epsAcceleration: 0.20,
      beatsLast4: 4,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('eps_contraction_severe');
  });
});

describe('computeStage2Gate — leniency on missing data', () => {
  it('passes when no EPS signal is available (let composite decide)', () => {
    const result = computeStage2Gate({});
    expect(result.passed).toBe(true);
    expect(result.reason).toBe('no_eps_signal');
  });
});

describe('computeStage2Gate — anemic EPS with offsets', () => {
  it('passes anemic EPS when operating margin is expanding', () => {
    expect(computeStage2Gate({ eps: 0.02, operatingMarginTrendPp: 2 }).passed).toBe(true);
  });

  it('passes anemic EPS when multiple is expanding', () => {
    expect(computeStage2Gate({ eps: 0.02, peExpansion: 0.10 }).passed).toBe(true);
  });

  it('passes anemic EPS when growth is accelerating', () => {
    expect(computeStage2Gate({ eps: 0.02, epsAcceleration: 0.08 }).passed).toBe(true);
  });

  it('passes anemic EPS when there is a beats streak', () => {
    expect(computeStage2Gate({ eps: 0.02, beatsLast4: 3 }).passed).toBe(true);
  });
});

describe('computeStage2Gate — anemic EPS without offsets', () => {
  it('rejects when EPS is weak and no quality signals offset', () => {
    const result = computeStage2Gate({
      eps: 0.02,
      operatingMarginTrendPp: 0,
      peExpansion: 0,
      epsAcceleration: 0,
      beatsLast4: 1,
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toBe('eps_weak_no_quality_offsets');
  });

  it('rejects when EPS contracting mildly with no offsets', () => {
    expect(computeStage2Gate({ eps: -0.05 }).passed).toBe(false);
  });
});

describe('computeStage2Gate — healthy EPS', () => {
  it('passes with EPS growth above 5%', () => {
    expect(computeStage2Gate({ eps: 0.10 }).passed).toBe(true);
    expect(computeStage2Gate({ eps: 0.50 }).passed).toBe(true);
  });
});
