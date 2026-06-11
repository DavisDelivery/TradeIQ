// Wave 3C (M7) — imminent earnings is EVENT RISK, not a direction.
//
// Pre-fix, runEarnings encoded "earnings in ≤5d" as raw −30 → direction
// 'short' with confidence up to 0.7: a phantom bearish vote that inflated
// conflictLevel and capped tiers on coherent bullish names. Post-fix the
// imminence signal is neutral (contributes zero raw score), flags event
// risk in the rationale/signals, and halves confidence; directional score
// is reserved for the beats-history component.

import { describe, it, expect } from 'vitest';
import { runEarnings } from '../analysts/core';
import { composeTarget } from '../shared/analyst-runner';
import type { AnalystOutput, Direction } from '../shared/types';
import type { UpcomingEarning, EarningsSurprise } from '../shared/data-provider';

const IN_3_DAYS = new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10);

const BULLISH_HISTORY: EarningsSurprise[] = [
  { period: '2026-03-31', announceDate: '2026-04-29', epsActual: 1.20, epsEstimate: 1.10 },
  { period: '2025-12-31', announceDate: '2026-01-28', epsActual: 1.10, epsEstimate: 1.00 },
  { period: '2025-09-30', announceDate: '2025-10-29', epsActual: 1.05, epsEstimate: 0.98 },
  { period: '2025-06-30', announceDate: '2025-07-30', epsActual: 1.00, epsEstimate: 0.92 },
];

describe('runEarnings — imminence is neutral event risk, not a short vote (M7)', () => {
  it('earnings in ≤5d with no history → neutral score 50 + event-risk rationale + reduced confidence', () => {
    const upcoming: UpcomingEarning = { ticker: 'XYZ', date: IN_3_DAYS };
    const out = runEarnings(upcoming, []);

    expect(out.score).toBe(50);
    expect(out.direction).toBe('neutral');
    expect(out.rationale).toMatch(/earnings in \dd — event risk/);
    expect(out.signals.eventRisk).toBe(true);
    expect(out.signals._noData).toBeUndefined();
    // No-history base confidence 0.4, halved for event risk.
    expect(out.confidence).toBeCloseTo(0.2, 5);
  });

  it('earnings in ≤5d does NOT override a bullish beats-history direction', () => {
    const upcoming: UpcomingEarning = { ticker: 'XYZ', date: IN_3_DAYS };
    const out = runEarnings(upcoming, BULLISH_HISTORY);

    // 4/4 beats → raw +20 → score 60, direction long. Pre-fix the −30
    // imminence penalty netted raw −10 → score 45, direction 'short'.
    expect(out.score).toBe(60);
    expect(out.direction).toBe('long');
    expect(out.rationale).toContain('event risk');
    expect(out.rationale).toContain('4/4 beats');
    // History base confidence 0.7, halved for event risk.
    expect(out.confidence).toBeCloseTo(0.35, 5);
  });

  it('confidence is NOT discounted outside the imminence window', () => {
    const farOut: UpcomingEarning = {
      ticker: 'XYZ',
      date: new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10),
    };
    const out = runEarnings(farOut, BULLISH_HISTORY);
    expect(out.confidence).toBeCloseTo(0.7, 5);
    expect(out.signals.eventRisk).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Composite integration — the phantom short vote no longer flips
// conflictLevel on an otherwise-bullish name.
// ---------------------------------------------------------------------------

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

function mock(score: number, direction: Direction, confidence = 0.8, noData = false): AnalystOutput {
  return {
    score,
    direction,
    confidence,
    rationale: 'test',
    signals: noData ? { _noData: true, _reason: 'test' } : {},
  };
}

describe('composeTarget — imminent earnings does not manufacture conflict (M7)', () => {
  it('coherent bullish name with earnings in 3d → conflictLevel none, direction long', () => {
    // earnings-analyst output produced by the REAL runEarnings on a
    // bullish-history + imminent-print input — not a hand-built mock — so
    // the test breaks if the encoding regresses.
    const earn = runEarnings({ ticker: 'XYZ', date: IN_3_DAYS }, BULLISH_HISTORY);
    expect(earn.direction).not.toBe('short'); // sanity: the phantom vote is gone

    const analysts: Record<string, AnalystOutput> = {
      'technical-analyst': mock(85, 'long', 0.9),
      'sector-rotation': mock(75, 'long', 0.7),
      'fundamental-analyst': mock(85, 'long', 0.9),
      'flow-analyst': mock(80, 'long', 0.8),
      'news-sentiment': mock(75, 'long', 0.7),
      'earnings-analyst': earn,
      'macro-regime': mock(50, 'neutral', 0, true),
      'insider-analyst': mock(85, 'long', 0.9),
      'patent-analyst': mock(50, 'neutral', 0, true),
      'political-analyst': mock(75, 'long', 0.7),
    };

    const r = composeTarget(analysts, LIVE_WEIGHTS);

    // Pre-fix: earn = { score 45, direction 'short', confidence 0.7 } →
    // one confident dissenter → conflictLevel 'mild'. Post-fix the
    // earnings analyst votes WITH the tape (4/4 beats) and conflict is none.
    expect(r.direction).toBe('long');
    expect(r.conflictLevel).toBe('none');
    expect(r.tier).toBe('A');
  });
});
