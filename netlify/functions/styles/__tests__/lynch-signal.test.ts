import { describe, expect, it } from 'vitest';
import {
  deriveLynchSignal,
  deriveLynchSignalFromAnalyst,
  PEG_FAIR_UPPER,
  PEG_AVOID_THRESHOLD,
  DE_AVOID_THRESHOLD,
} from '../lynch-signal';

describe('deriveLynchSignal — verdict from indicator confluence', () => {
  it('BUYs when PEG is in the sweet spot, growth is sustainable, debt is low, qtrs consistent', () => {
    const sig = deriveLynchSignal({
      score: 60,
      peg: 0.8,
      peRatio: 20,
      epsGrowthYoYPct: 25,
      revGrowthYoYPct: 22,
      debtToEquity: 0.2,
      positiveQtrs: 4,
      currentPrice: 50,
      ttmEps: 2.5,
    });
    expect(sig.verdict).toBe('BUY');
    expect(sig.fairValueLow).not.toBeNull();
    expect(sig.fairValueHigh).not.toBeNull();
    expect(sig.invalidationConditions.length).toBeGreaterThan(0);
  });

  it('AVOIDs when PEG > 2.0 even if other pillars are decent', () => {
    const sig = deriveLynchSignal({
      score: 25,
      peg: 2.5,
      peRatio: 50,
      epsGrowthYoYPct: 20,
      revGrowthYoYPct: 18,
      debtToEquity: 0.2,
      positiveQtrs: 4,
    });
    expect(sig.verdict).toBe('AVOID');
    expect(sig.reasons.some((r) => r.includes('PEG'))).toBe(true);
    // No invalidation list on AVOID — thesis already broken.
    expect(sig.invalidationConditions).toHaveLength(0);
  });

  it('AVOIDs unprofitable companies (negative PE)', () => {
    const sig = deriveLynchSignal({
      score: -20,
      peRatio: -10,
      revGrowthYoYPct: 10,
      positiveQtrs: 1,
    });
    expect(sig.verdict).toBe('AVOID');
    expect(sig.reasons.some((r) => /unprofitable|loss|EPS/i.test(r))).toBe(true);
  });

  it('AVOIDs over-levered companies (D/E > 2)', () => {
    const sig = deriveLynchSignal({
      score: 25,
      peg: 0.9,
      epsGrowthYoYPct: 22,
      revGrowthYoYPct: 18,
      debtToEquity: 2.6,
      positiveQtrs: 4,
    });
    expect(sig.verdict).toBe('AVOID');
    expect(sig.reasons.some((r) => /D\/E|leveraged/i.test(r))).toBe(true);
  });

  it('AVOIDs declining-revenue companies', () => {
    const sig = deriveLynchSignal({
      score: 0,
      peg: 1.2,
      epsGrowthYoYPct: 10,
      revGrowthYoYPct: -8,
      positiveQtrs: 4,
    });
    expect(sig.verdict).toBe('AVOID');
    expect(sig.reasons.some((r) => /declining|revenue/i.test(r))).toBe(true);
  });

  it('HOLDs when PEG is above sweet spot but below avoid threshold', () => {
    const sig = deriveLynchSignal({
      score: 15,
      peg: 1.7, // > 1.5 (sweet-spot upper) but < 2.0 (avoid)
      epsGrowthYoYPct: 15,
      revGrowthYoYPct: 12,
      debtToEquity: 0.5,
      positiveQtrs: 4,
    });
    expect(sig.verdict).toBe('HOLD');
  });

  it('HOLDs when fundamentals look BUY-ish but score is below floor', () => {
    const sig = deriveLynchSignal({
      score: 22, // below BUY_SCORE_FLOOR (30)
      peg: 0.9,
      epsGrowthYoYPct: 20,
      revGrowthYoYPct: 18,
      debtToEquity: 0.3,
      positiveQtrs: 4,
    });
    expect(sig.verdict).toBe('HOLD');
  });

  it('emits a fair-value band when EPS and growth are available', () => {
    const sig = deriveLynchSignal({
      score: 60,
      peg: 0.8,
      epsGrowthYoYPct: 20,
      revGrowthYoYPct: 18,
      debtToEquity: 0.2,
      positiveQtrs: 4,
      ttmEps: 5,
    });
    // PEG = 1.0 → fair P/E ≈ growth%  → 5 × 20 = 100
    // PEG = 1.5 → fair P/E ≈ 30       → 5 × 30 = 150
    expect(sig.fairValueLow).toBeCloseTo(100, 0);
    expect(sig.fairValueHigh).toBeCloseTo(150, 0);
  });

  it('omits the fair-value band for unprofitable companies', () => {
    const sig = deriveLynchSignal({
      score: -15,
      peRatio: -5,
      epsGrowthYoYPct: 10,
      revGrowthYoYPct: 5,
      positiveQtrs: 1,
      ttmEps: -2,
    });
    expect(sig.fairValueLow).toBeNull();
    expect(sig.fairValueHigh).toBeNull();
  });

  it('downgrades BUY → HOLD when price already exceeds fair-value ceiling', () => {
    const sig = deriveLynchSignal({
      score: 60,
      peg: 0.8,
      epsGrowthYoYPct: 20,
      revGrowthYoYPct: 18,
      debtToEquity: 0.2,
      positiveQtrs: 4,
      ttmEps: 5,
      currentPrice: 200, // above the 150 ceiling
    });
    expect(sig.verdict).toBe('HOLD');
    expect(sig.reasons.some((r) => /above fair-value/i.test(r))).toBe(true);
  });

  it('uses a fundamental-invalidation list instead of a price stop', () => {
    const sig = deriveLynchSignal({
      score: 60,
      peg: 0.8,
      epsGrowthYoYPct: 20,
      revGrowthYoYPct: 18,
      debtToEquity: 0.2,
      positiveQtrs: 4,
      currentPrice: 80,
      ttmEps: 5,
    });
    expect(sig.verdict).toBe('BUY');
    expect(sig.invalidationConditions).toContain(
      `PEG expands above ${PEG_AVOID_THRESHOLD.toFixed(1)}`,
    );
    expect(sig.invalidationConditions).toContain(
      `Debt-to-equity exceeds ${DE_AVOID_THRESHOLD.toFixed(1)}`,
    );
    // No price stop — every condition is fundamental.
    for (const c of sig.invalidationConditions) {
      expect(c).not.toMatch(/\$[0-9]/);
    }
  });
});

describe('deriveLynchSignalFromAnalyst — pulls signals dict', () => {
  it('reads signal fields from the AnalystScore.signals dict', () => {
    const sig = deriveLynchSignalFromAnalyst(
      {
        score: 55,
        signals: {
          peg: 0.7,
          peRatio: 15,
          epsGrowthYoYPct: 22,
          revGrowthYoYPct: 20,
          debtToEquity: 0.25,
          positiveQtrs: 4,
        },
      },
      { currentPrice: 40, ttmEps: 2.5 },
    );
    expect(sig.verdict).toBe('BUY');
    expect(sig.peg).toBeCloseTo(0.7, 2);
    // Sanity: fair upper = 2.5 × 22 × 1.5 = 82.5
    expect(sig.fairValueHigh!).toBeGreaterThan(75);
    expect(sig.fairValueHigh!).toBeLessThan(90);
  });
});

// Sanity guards over the constant choices.
describe('Lynch signal constants are internally consistent', () => {
  it('PEG sweet-spot upper bound < avoid threshold', () => {
    expect(PEG_FAIR_UPPER).toBeLessThan(PEG_AVOID_THRESHOLD);
  });
});
