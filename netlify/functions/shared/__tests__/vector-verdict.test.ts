import { describe, it, expect } from 'vitest';
import { scoreFAxis, scoreTAxis, evaluateVector, type FInputs, type TInputs } from '../vector-verdict';
import { quadrantOf, sizeBucketOf, VECTOR_MODEL_VERSION } from '../vector-constants';

const F_BASE: FInputs = {
  fscore: null, latestSue: null, consecutivePositiveSue: 0,
  insiderNet90d: null, sellCluster: false, instDelta: null,
};
const T_BASE: TInputs = {
  close: 100, sma50: null, sma200: null, extension: null, contraction: null,
  regime: null, drawdown: null, ema20: null, higherFiveDayLow: null,
};

describe('F axis', () => {
  it('maxes at 6 and reads STRONG at >= 4', () => {
    const r = scoreFAxis({
      fscore: 8, latestSue: 2.1, consecutivePositiveSue: 3,
      insiderNet90d: 250_000, sellCluster: false, instDelta: 4,
    });
    expect(r.points).toBe(6);
    expect(r.max).toBe(6);
    expect(r.verdict).toBe('STRONG');
    expect(r.noData).toEqual([]);
  });

  it('cut lines: 4 STRONG / 3 and 2 NEUTRAL / 1 WEAK', () => {
    // fscore 8 (+2), SUE 1.5 (+1), 2 consecutive (+1) = 4 -> STRONG
    expect(scoreFAxis({ ...F_BASE, fscore: 8, latestSue: 1.5, consecutivePositiveSue: 2 }).verdict).toBe('STRONG');
    // fscore 8 (+2), SUE (+1) = 3 -> NEUTRAL
    expect(scoreFAxis({ ...F_BASE, fscore: 8, latestSue: 1.5 }).verdict).toBe('NEUTRAL');
    // fscore 8 (+2) = 2 -> NEUTRAL
    expect(scoreFAxis({ ...F_BASE, fscore: 8 }).verdict).toBe('NEUTRAL');
    // fscore 5 (+1) = 1 -> WEAK
    expect(scoreFAxis({ ...F_BASE, fscore: 5 }).verdict).toBe('WEAK');
  });

  it('sellCluster subtracts a point', () => {
    const without = scoreFAxis({ ...F_BASE, fscore: 8, latestSue: 1.5, consecutivePositiveSue: 2 });
    const withSell = scoreFAxis({ ...F_BASE, fscore: 8, latestSue: 1.5, consecutivePositiveSue: 2, sellCluster: true });
    expect(withSell.points).toBe(without.points - 1);
    expect(withSell.verdict).toBe('NEUTRAL'); // 4 -> 3
  });

  it('null fscore computes the axis from the rest and flags _noData', () => {
    const r = scoreFAxis({ ...F_BASE, latestSue: 1.2, consecutivePositiveSue: 2, insiderNet90d: 150_000, instDelta: 3 });
    expect(r.noData).toContain('fscore');
    expect(r.points).toBe(4); // 1+1+1+1 without any fscore contribution
    expect(r.verdict).toBe('STRONG');
  });

  it('thresholds are exact: SUE +1, $100k, +2 institutions', () => {
    expect(scoreFAxis({ ...F_BASE, latestSue: 0.99 }).points).toBe(0);
    expect(scoreFAxis({ ...F_BASE, latestSue: 1.0 }).points).toBe(1);
    expect(scoreFAxis({ ...F_BASE, insiderNet90d: 99_999 }).points).toBe(0);
    expect(scoreFAxis({ ...F_BASE, insiderNet90d: 100_000 }).points).toBe(1);
    expect(scoreFAxis({ ...F_BASE, instDelta: 1 }).points).toBe(0);
    expect(scoreFAxis({ ...F_BASE, instDelta: 2 }).points).toBe(1);
  });
});

describe('T axis — standard path', () => {
  it('full alignment reads GOOD: trend both (+2), extension ok (+1), contraction (+1), offense (+1) = 5', () => {
    const r = scoreTAxis({
      ...T_BASE, close: 110, sma50: 105, sma200: 100,
      extension: 0.05, contraction: 0.8, regime: 'offense', drawdown: 0.05,
    });
    expect(r.points).toBe(5);
    expect(r.verdict).toBe('GOOD');
    expect(r.drawdownVariant).toBe(false);
  });

  it('close > SMA200 without SMA50 alignment earns +1 not +2', () => {
    const both = scoreTAxis({ ...T_BASE, close: 110, sma50: 105, sma200: 100, drawdown: 0 });
    const closeOnly = scoreTAxis({ ...T_BASE, close: 110, sma50: 95, sma200: 100, drawdown: 0 });
    expect(both.points).toBe(2);
    expect(closeOnly.points).toBe(1);
  });

  it('extension > 35% forces POOR regardless of other points (never buy the parabola)', () => {
    const r = scoreTAxis({
      ...T_BASE, close: 150, sma50: 105, sma200: 100,
      extension: 0.42, contraction: 0.7, regime: 'offense', drawdown: 0,
    });
    expect(r.verdict).toBe('POOR');
    expect(r.forcedPoor).toMatch(/extension/);
  });

  it('regime panic forces POOR', () => {
    const r = scoreTAxis({
      ...T_BASE, close: 110, sma50: 105, sma200: 100,
      extension: 0.05, contraction: 0.7, regime: 'panic', drawdown: 0,
    });
    expect(r.verdict).toBe('POOR');
    expect(r.forcedPoor).toMatch(/panic/);
  });

  it('cut lines: 2-3 NEUTRAL, <= 1 POOR', () => {
    // +2 trend only = 2 -> NEUTRAL
    const neutral = scoreTAxis({ ...T_BASE, close: 110, sma50: 105, sma200: 100, extension: 0.2, contraction: 0.95, regime: 'neutral', drawdown: 0 });
    expect(neutral.points).toBe(2);
    expect(neutral.verdict).toBe('NEUTRAL');
    // +1 close-only = 1 -> POOR
    const poor = scoreTAxis({ ...T_BASE, close: 110, sma50: 95, sma200: 100, extension: 0.2, contraction: 0.95, regime: 'neutral', drawdown: 0 });
    expect(poor.points).toBe(1);
    expect(poor.verdict).toBe('POOR');
  });
});

describe('T axis — drawdown variant (dd >= 20%)', () => {
  it('stabilized knife (close > EMA20 + higher 5d low) reads GOOD even with zero trend points', () => {
    const r = scoreTAxis({
      ...T_BASE, close: 80, sma50: 95, sma200: 100, // below both SMAs
      extension: -0.15, contraction: 1.1, regime: 'neutral',
      drawdown: 0.3, ema20: 78, higherFiveDayLow: true,
    });
    expect(r.drawdownVariant).toBe(true);
    expect(r.verdict).toBe('GOOD');
  });

  it('falling knife (no stabilization) is POOR by definition', () => {
    const noHigherLow = scoreTAxis({
      ...T_BASE, close: 80, drawdown: 0.3, ema20: 78, higherFiveDayLow: false, regime: 'neutral',
    });
    expect(noHigherLow.verdict).toBe('POOR');
    expect(noHigherLow.forcedPoor).toMatch(/falling knife/);
    const belowEma = scoreTAxis({
      ...T_BASE, close: 76, drawdown: 0.3, ema20: 78, higherFiveDayLow: true, regime: 'neutral',
    });
    expect(belowEma.verdict).toBe('POOR');
  });

  it('extension rule is waived in the variant (parabolic extension does not force POOR)', () => {
    const r = scoreTAxis({
      ...T_BASE, close: 80, extension: 0.5, drawdown: 0.25,
      ema20: 78, higherFiveDayLow: true, regime: 'neutral',
    });
    expect(r.verdict).toBe('GOOD'); // stabilized wins; extension waived
  });

  it('panic still forces POOR inside the variant', () => {
    const r = scoreTAxis({
      ...T_BASE, close: 80, drawdown: 0.3, ema20: 78, higherFiveDayLow: true, regime: 'panic',
    });
    expect(r.verdict).toBe('POOR');
  });

  it('dd 19.9% stays on the standard path; 20% enters the variant', () => {
    expect(scoreTAxis({ ...T_BASE, close: 80, drawdown: 0.199 }).drawdownVariant).toBe(false);
    expect(scoreTAxis({ ...T_BASE, close: 80, drawdown: 0.2, ema20: 78, higherFiveDayLow: true }).drawdownVariant).toBe(true);
  });
});

describe('quadrants', () => {
  it('maps the 2x2 exactly per design', () => {
    expect(quadrantOf('STRONG', 'GOOD')).toBe('PRIME');
    expect(quadrantOf('STRONG', 'NEUTRAL')).toBe('WAIT');
    expect(quadrantOf('STRONG', 'POOR')).toBe('WAIT');
    expect(quadrantOf('NEUTRAL', 'GOOD')).toBe('RENT');
    expect(quadrantOf('WEAK', 'GOOD')).toBe('RENT');
    expect(quadrantOf('NEUTRAL', 'NEUTRAL')).toBe('PASS');
    expect(quadrantOf('WEAK', 'POOR')).toBe('PASS');
  });

  it('evaluateVector wires both axes into a quadrant', () => {
    const v = evaluateVector(
      { fscore: 8, latestSue: 2, consecutivePositiveSue: 2, insiderNet90d: 200_000, sellCluster: false, instDelta: 3 },
      { ...T_BASE, close: 110, sma50: 105, sma200: 100, extension: 0.05, contraction: 0.8, regime: 'offense', drawdown: 0.02 },
    );
    expect(v.f.verdict).toBe('STRONG');
    expect(v.t.verdict).toBe('GOOD');
    expect(v.quadrant).toBe('PRIME');
  });
});

describe('size buckets + version', () => {
  it('buckets by 63d median dollar volume with exact edges', () => {
    expect(sizeBucketOf(50_000_000)).toBe('LARGE');
    expect(sizeBucketOf(49_999_999)).toBe('MID');
    expect(sizeBucketOf(10_000_000)).toBe('MID');
    expect(sizeBucketOf(9_999_999)).toBe('SMALL');
    expect(sizeBucketOf(2_000_000)).toBe('SMALL');
    expect(sizeBucketOf(1_999_999)).toBeNull(); // fails hygiene
  });

  it('model version starts at 1.0.0', () => {
    expect(VECTOR_MODEL_VERSION).toBe('1.0.0');
  });
});
