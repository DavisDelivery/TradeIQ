// Tests for 4c-2 sieve Stage 2 — earnings-quality gate logic.
//
// computeStage2Gate is a pure function; we exercise it directly. The
// orchestration + scoring is integration-tested via the live deploy preview
// smoke test (sieve-stage2-orchestration is excessive for unit-test value).

import { describe, it, expect } from 'vitest';
import { computeStage2Gate } from '../prophet-sieve/stage2';

describe('Stage 2 earnings-quality gate', () => {
  it('passes a STRONG signal set', () => {
    const g = computeStage2Gate({
      eps: 0.30,
      operatingMarginTrendPp: 2,
      peExpansion: 0.15,
      epsAcceleration: 0.10,
      beatsLast4: 4,
    });
    expect(g.passed).toBe(true);
    expect(g.reason).toBe('ok');
  });

  it('hard-fails on severe EPS contraction', () => {
    const g = computeStage2Gate({
      eps: -0.25,
      operatingMarginTrendPp: 5,
      peExpansion: 0.50,
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toBe('eps_contraction_severe');
  });

  it('passes lenient when EPS signal is entirely missing (no_eps_signal)', () => {
    const g = computeStage2Gate({ eps: undefined });
    expect(g.passed).toBe(true);
    expect(g.reason).toBe('no_eps_signal');
  });

  it('passes weak EPS when margin is expanding', () => {
    const g = computeStage2Gate({
      eps: 0.02,
      operatingMarginTrendPp: 2,
    });
    expect(g.passed).toBe(true);
  });

  it('passes weak EPS when multiple is expanding', () => {
    const g = computeStage2Gate({
      eps: 0.02,
      peExpansion: 0.10,
    });
    expect(g.passed).toBe(true);
  });

  it('passes weak EPS when accelerating', () => {
    const g = computeStage2Gate({
      eps: 0.02,
      epsAcceleration: 0.08,
    });
    expect(g.passed).toBe(true);
  });

  it('passes weak EPS when beats streak (>=3/4)', () => {
    const g = computeStage2Gate({
      eps: 0.02,
      beatsLast4: 3,
    });
    expect(g.passed).toBe(true);
  });

  it('fails weak EPS with no quality offsets', () => {
    const g = computeStage2Gate({
      eps: 0.02,
      operatingMarginTrendPp: 0,
      peExpansion: 0,
      epsAcceleration: 0,
      beatsLast4: 1,
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toBe('eps_weak_no_quality_offsets');
  });

  it('treats null beatsLast4 as no-signal (no offset)', () => {
    const g = computeStage2Gate({
      eps: 0.02,
      beatsLast4: null,
    });
    expect(g.passed).toBe(false);
    expect(g.reason).toBe('eps_weak_no_quality_offsets');
  });

  it('treats EPS exactly at the 5% growth threshold as passing without offset checks', () => {
    const g = computeStage2Gate({
      eps: 0.05,
      operatingMarginTrendPp: 0,
      peExpansion: 0,
    });
    expect(g.passed).toBe(true);
  });
});
