// Wave 2B regression — evidence ordering for aligned contributions.
//
// `score` is a 0-100 bullishness scale, so the most convincing contributor
// for a SHORT is the LOWEST score. The topSignals/rationale sites used to
// sort `b.score - a.score` for both directions, which made short candidates
// surface and quote their LEAST convincing analysts.

import { describe, expect, it } from 'vitest';
import { buildRationale, byEvidenceStrength } from '../analyst-runner';
import type { AnalystContribution, AnalystOutput, Direction } from '../types';

function contrib(analyst: string, score: number, direction: Direction): AnalystContribution {
  return { analyst, score, direction, weight: 0.1 };
}

function output(score: number, direction: Direction, rationale: string, confidence = 0.8): AnalystOutput {
  return { score, direction, confidence, rationale, signals: {} };
}

describe('byEvidenceStrength', () => {
  it('shorts sort ascending — most bearish (lowest score) first', () => {
    const cs = [
      contrib('flow-analyst', 45, 'short'),
      contrib('technical-analyst', 10, 'short'),
      contrib('news-sentiment', 30, 'short'),
    ];
    const sorted = [...cs].sort(byEvidenceStrength('short'));
    expect(sorted.map((c) => c.score)).toEqual([10, 30, 45]);
  });

  it('longs sort descending — most bullish (highest score) first', () => {
    const cs = [
      contrib('flow-analyst', 60, 'long'),
      contrib('technical-analyst', 95, 'long'),
      contrib('news-sentiment', 75, 'long'),
    ];
    const sorted = [...cs].sort(byEvidenceStrength('long'));
    expect(sorted.map((c) => c.score)).toEqual([95, 75, 60]);
  });
});

describe('buildRationale — quotes the strongest aligned evidence', () => {
  it('short rationale quotes the most bearish analysts, not the weakest', () => {
    const contributions = [
      contrib('flow-analyst', 45, 'short'),
      contrib('technical-analyst', 10, 'short'),
      contrib('news-sentiment', 25, 'short'),
      contrib('insider-analyst', 80, 'long'),
    ];
    const analysts: Record<string, AnalystOutput> = {
      'flow-analyst': output(45, 'short', 'mild put skew'),
      'technical-analyst': output(10, 'short', 'decisive breakdown below support'),
      'news-sentiment': output(25, 'short', 'negative news cluster'),
      'insider-analyst': output(80, 'long', 'cluster buying'),
    };

    const rationale = buildRationale('short', contributions, analysts);

    expect(rationale).toContain('Net short: 3 analysts aligned bearish.');
    // Strongest two bearish rationales quoted (scores 10 and 25)…
    expect(rationale).toContain('decisive breakdown below support');
    expect(rationale).toContain('negative news cluster');
    // …and the weakest (score 45) is NOT — pre-fix it led the quote list.
    expect(rationale).not.toContain('mild put skew');
  });

  it('long rationale still quotes the most bullish analysts', () => {
    const contributions = [
      contrib('flow-analyst', 60, 'long'),
      contrib('technical-analyst', 95, 'long'),
      contrib('news-sentiment', 85, 'long'),
    ];
    const analysts: Record<string, AnalystOutput> = {
      'flow-analyst': output(60, 'long', 'modest call flow'),
      'technical-analyst': output(95, 'long', 'powerful breakout'),
      'news-sentiment': output(85, 'long', 'glowing coverage'),
    };

    const rationale = buildRationale('long', contributions, analysts);

    expect(rationale).toContain('powerful breakout');
    expect(rationale).toContain('glowing coverage');
    expect(rationale).not.toContain('modest call flow');
  });
});
