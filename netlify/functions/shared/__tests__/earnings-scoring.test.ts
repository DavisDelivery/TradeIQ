// FIX-2 W1 — pure earnings classification + composite scoring tests.
//
// These pin the EXACT pre-FIX-2 behaviour of the extracted module so the
// scan-earnings refactor is provably behaviour-preserving, and so W3 has a
// red-line reference for what it is replacing (the composite constants).

import { describe, it, expect } from 'vitest';
import {
  classifyEarnings,
  scoreEarningsComposite,
  computeDriftLean,
  annVol,
  chunksAnnVol,
  avg,
  type EarningsClassifyInput,
} from '../earnings-scoring';

const base: EarningsClassifyInput = {
  postPrint: false,
  surprise: null,
  lastMove: null,
  volRatio: 1,
  rvRank: 50,
  avgPriorMove: null,
  expectedMove: 5,
  drift20: 0,
  driftLean: 'mixed',
};

describe('computeDriftLean', () => {
  it('long when 20d>5 and 5d>2', () => {
    expect(computeDriftLean(3, 9).lean).toBe('long');
  });
  it('short when 20d<-5 and 5d<-2', () => {
    expect(computeDriftLean(-3, -9).lean).toBe('short');
  });
  it('mixed otherwise', () => {
    expect(computeDriftLean(1, 4).lean).toBe('mixed');
    expect(computeDriftLean(-3, 9).lean).toBe('mixed'); // conflicting
  });
});

describe('classifyEarnings — post-print (PEAD / reversal)', () => {
  it('pead_long on a beat + up-gap + volume', () => {
    const c = classifyEarnings({ ...base, postPrint: true, surprise: 8, lastMove: 6, volRatio: 1.4 });
    expect(c.playType).toBe('pead_long');
    expect(c.direction).toBe('long');
  });
  it('pead_short on a miss + down-gap + volume', () => {
    const c = classifyEarnings({ ...base, postPrint: true, surprise: -8, lastMove: -6, volRatio: 1.4 });
    expect(c.playType).toBe('pead_short');
    expect(c.direction).toBe('short');
  });
  it('reversal fades the gap AGAINST the surprise; direction is the fade side', () => {
    // gap UP (+6) on a MISS (−8) → fade short
    const up = classifyEarnings({ ...base, postPrint: true, surprise: -8, lastMove: 6, volRatio: 1.6 });
    expect(up.playType).toBe('reversal');
    expect(up.direction).toBe('short');
    // gap DOWN (−6) on a BEAT (+8) → fade long
    const down = classifyEarnings({ ...base, postPrint: true, surprise: 8, lastMove: -6, volRatio: 1.6 });
    expect(down.playType).toBe('reversal');
    expect(down.direction).toBe('long');
  });
  it('skip when volume confirmation is missing', () => {
    expect(classifyEarnings({ ...base, postPrint: true, surprise: 8, lastMove: 6, volRatio: 1.1 }).playType).toBe('skip');
  });
});

describe('classifyEarnings — pre-print (vol / drift)', () => {
  it('long_volatility: low RV rank + history of big moves', () => {
    const c = classifyEarnings({ ...base, rvRank: 20, avgPriorMove: 8, expectedMove: 5 });
    expect(c.playType).toBe('long_volatility');
  });
  it('short_volatility: high RV rank + contained history', () => {
    const c = classifyEarnings({ ...base, rvRank: 80, avgPriorMove: 3, expectedMove: 5 });
    expect(c.playType).toBe('short_volatility');
  });
  it('directional_long on strong bullish drift', () => {
    const c = classifyEarnings({ ...base, driftLean: 'long', drift20: 12 });
    expect(c.playType).toBe('directional_long');
    expect(c.direction).toBe('long');
  });
  it('skip on mixed data', () => {
    expect(classifyEarnings({ ...base, rvRank: 50, avgPriorMove: 5, expectedMove: 5 }).playType).toBe('skip');
  });
});

describe('scoreEarningsComposite — pins the pre-FIX-2 constants (W3 replaces this)', () => {
  const s = (pt: any, o: Partial<Parameters<typeof scoreEarningsComposite>[1]> = {}) =>
    scoreEarningsComposite(pt, { rvRank: 50, drift20: 0, surprisePct: 0, daysUntil: 10, postPrint: false, ...o });

  it('pead scales with |surprise| off a base of 70', () => {
    expect(s('pead_long', { surprisePct: 8 })).toBe(78);
    expect(s('pead_short', { surprisePct: 25 })).toBe(90); // capped at +20
  });
  it('short_volatility scales with RV richness off 75', () => {
    expect(s('short_volatility', { rvRank: 85 })).toBe(85); // 75 + min(15, round(10))
  });
  it('long_volatility scales with RV cheapness off 75', () => {
    expect(s('long_volatility', { rvRank: 15 })).toBe(85); // 75 + min(15, round(10))
  });
  it('directional scales with |drift20| off 65', () => {
    expect(s('directional_long', { drift20: 30 })).toBe(80); // 65 + min(20, 15)
  });
  it('reversal is flat 65, skip is 35', () => {
    expect(s('reversal')).toBe(65);
    expect(s('skip')).toBe(35);
  });
  it('imminent pre-print (|daysUntil|<=1) takes a −5 haircut', () => {
    expect(s('reversal', { daysUntil: 1, postPrint: false })).toBe(60);
    // ...but not post-print
    expect(s('reversal', { daysUntil: -1, postPrint: true })).toBe(65);
  });
});

describe('vol helpers', () => {
  it('avg + annVol are finite and sane', () => {
    expect(avg([1, 2, 3])).toBe(2);
    const rets = Array.from({ length: 30 }, (_, i) => (i % 2 ? 0.01 : -0.01));
    expect(annVol(rets)).toBeGreaterThan(0);
    expect(chunksAnnVol(rets, 20).length).toBe(1);
  });
});
