// PROFILE-1 W3 — the peer engine, and the gates the kickoff calls
// non-negotiable. Each block below IS one of those gates.

import { describe, it, expect } from 'vitest';
import {
  buildPeerStat,
  quantile,
  median,
  isMeaningful,
  ordinalSuffix,
  MIN_POOL_FOR_PERCENTILE,
  WINSOR_LOW,
  WINSOR_HIGH,
  type PeerCandidate,
} from '../peer-stats';
import { METRIC_POLICY } from '../metric-direction';

const pool = (values: number[], prefix = 'P'): PeerCandidate[] =>
  values.map((v, i) => ({ ticker: `${prefix}${i}`, value: v }));

const big = (v: number[] = Array.from({ length: 40 }, (_, i) => i + 1)) => pool(v);

const stat = (over: Partial<Parameters<typeof buildPeerStat>[0]> = {}) =>
  buildPeerStat({
    metricKey: 'pe',
    subjectTicker: 'SUBJ',
    subjectValue: 20,
    pool: big(),
    poolLevel: 'sector',
    poolName: 'Specialty Retail',
    ...over,
  });

// ---------------------------------------------------------------------------
// GATE: no percentile renders with N < 20
// ---------------------------------------------------------------------------
describe('GATE — no percentile below N=20', () => {
  it('refuses a percentile on a small pool and gives an ordinal instead', () => {
    const s = stat({ pool: pool([10, 30, 50, 70, 90, 110, 130, 150, 170]) });
    expect(s.n).toBe(9);
    expect(s.percentile).toBeNull();
    expect(s.ordinal).not.toBeNull();
    expect(s.phrase).toMatch(/too few peers for a percentile/);
  });

  it('hands back the actual peer list at small N, where names beat a statistic', () => {
    const s = stat({ pool: pool([10, 30, 50]) });
    expect(s.peers?.map((p) => p.ticker)).toEqual(['P2', 'P1', 'P0']); // desc by value
  });

  it('reports the ordinal correctly', () => {
    // Subject 20 against 10/30/50: TWO peers are above it (30 and 50), so
    // the subject is 3rd highest of the four names.
    const s = stat({ subjectValue: 20, pool: pool([10, 30, 50]) });
    expect(s.ordinal).toBe(3);
    expect(s.phrase).toMatch(/3rd highest of 4/);
  });

  it('ranks a subject above every peer as 1st', () => {
    expect(stat({ subjectValue: 99, pool: pool([10, 30, 50]) }).ordinal).toBe(1);
  });

  it('produces a percentile exactly AT the floor', () => {
    const s = stat({ pool: big(Array.from({ length: MIN_POOL_FOR_PERCENTILE }, (_, i) => i + 1)) });
    expect(s.n).toBe(MIN_POOL_FOR_PERCENTILE);
    expect(s.percentile).not.toBeNull();
  });

  it('refuses one BELOW the floor', () => {
    const s = stat({ pool: big(Array.from({ length: MIN_POOL_FOR_PERCENTILE - 1 }, (_, i) => i + 1)) });
    expect(s.percentile).toBeNull();
  });

  it('never returns a percentile for a pool of one — the lone-name trap', () => {
    // quality-value.percentileRank returns 1.0 when the pool has a single
    // entry, which would render as "100th percentile" off one comparison.
    const s = stat({ pool: pool([42]) });
    expect(s.percentile).toBeNull();
    expect(s.n).toBe(1);
  });

  it('survives an empty pool', () => {
    const s = stat({ pool: [] });
    expect(s.n).toBe(0);
    expect(s.percentile).toBeNull();
    expect(s.median).toBeNull();
    expect(s.phrase).toMatch(/No comparable peers/);
  });
});

// ---------------------------------------------------------------------------
// GATE: every payload carries poolLevel, N, exclusions, winsorization
// ---------------------------------------------------------------------------
describe('GATE — provenance always travels with the number', () => {
  it('carries level, N and the winsorization note on every result', () => {
    for (const s of [stat(), stat({ pool: pool([1, 2]) }), stat({ subjectValue: -5 }), stat({ pool: [] })]) {
      expect(s.poolLevel).toBeTruthy();
      expect(s.poolLabel).toMatch(/Specialty Retail/);
      expect(typeof s.n).toBe('number');
      expect(typeof s.excludedCount).toBe('number');
      expect(s.winsorNote).toMatch(/2.5th and 97.5th/);
    }
  });

  it('names the pool LEVEL, so sector is never mistaken for industry', () => {
    expect(stat({ poolLevel: 'sector' }).poolLabel).toMatch(/\(sector\)/);
    expect(stat({ poolLevel: 'industry' }).poolLabel).toMatch(/\(industry\)/);
    expect(stat({ poolLevel: 'industry-group' }).poolLabel).toMatch(/\(industry group\)/);
  });

  it('prints N inside the phrase — nobody else does', () => {
    expect(stat().phrase).toMatch(/of 40 Specialty Retail peers/);
  });
});

// ---------------------------------------------------------------------------
// GATE: NM names leave the pool and are disclosed
// ---------------------------------------------------------------------------
describe('GATE — not-meaningful handling', () => {
  it('excludes negative-denominator peers from a P/E pool and discloses it', () => {
    const s = stat({ pool: pool([...Array.from({ length: 34 }, (_, i) => i + 1), -5, -3, -1, 0, -8, -2]) });
    expect(s.n).toBe(34);
    expect(s.excludedCount).toBe(6);
    expect(s.exclusionNote).toMatch(/34 of 40 have positive earnings/);
  });

  it('refuses to rank a LOSS-MAKING subject and says why', () => {
    const s = stat({ subjectValue: -12 });
    expect(s.subjectNotMeaningful).toBe(true);
    expect(s.percentile).toBeNull();
    expect(s.ordinal).toBeNull();
    expect(s.phrase).toMatch(/Not meaningful \(loss-making\)/);
  });

  it('keeps negative values for a metric that has no such exclusion', () => {
    // Net margin can legitimately be negative and still be comparable.
    const s = stat({ metricKey: 'netMargin', subjectValue: -4, pool: big() });
    expect(s.subjectNotMeaningful).toBe(false);
    expect(s.percentile).not.toBeNull();
  });

  it('isMeaningful follows the declared policy, not a guess', () => {
    expect(isMeaningful('pe', -1)).toBe(false);
    expect(isMeaningful('pe', 0)).toBe(false);
    expect(isMeaningful('pe', 12)).toBe(true);
    expect(isMeaningful('netMargin', -1)).toBe(true);
    expect(isMeaningful('pe', null)).toBe(false);
    expect(isMeaningful('pe', Number.NaN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// GATE: no valuation metric emits a good/bad verdict
// ---------------------------------------------------------------------------
describe('GATE — phrasing never becomes a verdict', () => {
  const BANNED = /\b(good|bad|great|poor|strong|weak|attractive|undervalued|overvalued|buy|sell|cheap enough)\b/i;

  it('produces no verdict language for ANY metric at ANY percentile', () => {
    for (const key of Object.keys(METRIC_POLICY)) {
      for (const subjectValue of [1, 20, 999]) {
        const s = stat({ metricKey: key, subjectValue });
        expect(s.phrase, `${key}@${subjectValue}`).not.toMatch(BANNED);
      }
    }
  });

  it('emits no letter grade and no composite score anywhere', () => {
    const s = stat();
    const json = JSON.stringify(s);
    expect(json).not.toMatch(/"grade"|"score"|"composite"|\b[A-F][+-]?\b(?=")/);
  });

  it('describes P/E as position, never as cheapness being good', () => {
    const s = stat({ metricKey: 'pe', subjectValue: 5 });
    expect(s.phrase).toMatch(/percentile/);
    expect(s.phrase).not.toMatch(/cheap|expensive/i);
  });
});

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------
describe('the centre line is a median', () => {
  it('is unmoved by one enormous outlier', () => {
    // A cap-weighted mean of a peer group is one mega-cap's number wearing
    // the group's name.
    const withOutlier = stat({ pool: pool([...Array.from({ length: 39 }, () => 10), 100000]) });
    expect(withOutlier.median).toBe(10);
  });

  it('returns null for an empty set rather than 0', () => {
    // One of the repo's five median implementations returns 0 here, which
    // turns "no peers" into "the peer median is zero".
    expect(median([])).toBeNull();
    expect(median([4])).toBe(4);
    expect(median([1, 3])).toBe(2);
    expect(median([1, 2, 3])).toBe(2);
  });
});

describe('winsorized display bounds', () => {
  it('clips the strip without touching the rank', () => {
    // 39 ordinary peers plus one absurd outlier. The subject sits ABOVE the
    // outlier, so it is the unique maximum and must rank at 1.0 — proving
    // the rank saw the untrimmed data even though the strip is clipped.
    const values = [...Array.from({ length: 39 }, (_, i) => i + 1), 100000];
    const s = stat({ subjectValue: 200000, pool: pool(values) });
    expect(s.displayHigh!).toBeLessThan(100000);
    expect(s.percentile).toBe(1);
  });

  it('tie-averages a shared maximum rather than awarding both 1.0', () => {
    // Subject equal to the largest peer: the pair splits the top two ranks.
    const values = [...Array.from({ length: 39 }, (_, i) => i + 1), 100000];
    const s = stat({ subjectValue: 100000, pool: pool(values) });
    expect(s.percentile).toBeLessThan(1);
    expect(s.percentile).toBeGreaterThan(0.98);
  });

  it('exposes the exact bounds used', () => {
    expect(WINSOR_LOW).toBe(0.025);
    expect(WINSOR_HIGH).toBe(0.975);
  });
});

describe('quantile', () => {
  it('interpolates linearly', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBeCloseTo(2.5, 10);
    expect(quantile([0, 10], 0.25)).toBeCloseTo(2.5, 10);
  });

  it('handles the degenerate cases', () => {
    expect(quantile([], 0.5)).toBeNull();
    expect(quantile([7], 0.9)).toBe(7);
    expect(quantile([1, 2, 3], 0)).toBe(1);
    expect(quantile([1, 2, 3], 1)).toBe(3);
  });
});

describe('the subject is never in its own pool', () => {
  it('drops a duplicate of the subject ticker', () => {
    const s = stat({
      subjectTicker: 'SUBJ',
      pool: [{ ticker: 'SUBJ', value: 20 }, ...pool([1, 2, 3])],
    });
    expect(s.n).toBe(3);
  });
});

describe('percentile direction', () => {
  it('is a MAGNITUDE percentile — larger value, higher percentile', () => {
    // Never "better". Direction is metric-direction's job, at phrasing time.
    const lo = stat({ subjectValue: 1 }).percentile!;
    const hi = stat({ subjectValue: 39 }).percentile!;
    expect(hi).toBeGreaterThan(lo);
  });

  it('is the same for a neutral metric and an arrow metric', () => {
    const a = stat({ metricKey: 'pe', subjectValue: 30 }).percentile;
    const b = stat({ metricKey: 'grossMargin', subjectValue: 30 }).percentile;
    expect(a).toBeCloseTo(b as number, 10);
  });
});

describe('ordinalSuffix', () => {
  it('handles the teens and the rest', () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinalSuffix))
      .toEqual(['st', 'nd', 'rd', 'th', 'th', 'th', 'th', 'st', 'nd', 'rd', 'st', 'th']);
  });
});
