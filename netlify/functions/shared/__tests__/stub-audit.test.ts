// Phase 4f — stub-audit shared-logic tests.
//
// All pure. Verify the ingestion + classification thresholds against
// hand-rolled synthetic snapshots that exercise live, stub, and
// degraded patterns.

import { describe, expect, it } from 'vitest';
import {
  classify,
  emptyStats,
  ingestProphetResults,
  ingestTargetResults,
  mean,
  stdev,
  statsToRow,
  type PerAnalystStats,
} from '../stub-audit';

describe('classify thresholds', () => {
  it('live = stdev > 5 AND pctExactly50 < 25%', () => {
    const s: PerAnalystStats = {
      count: 100,
      sum: 6000,
      sumSq: 6000 * 60, // mean=60, dist gives stdev ~ 0 → pump up
      exactly50: 10,
      nullCount: 0,
      failCount: 0,
      uniqueValues: new Set(),
    };
    // Adjust to get a real stdev > 5: sum=6000, sumSq=370000 → var=700, stdev≈26
    s.sumSq = 370000;
    expect(classify(s)).toBe('live');
  });

  it('stub = stdev < 2 OR pctExactly50 > 60%', () => {
    // Case A: all scores exactly 50.
    const allFifty: PerAnalystStats = {
      count: 100,
      sum: 5000,
      sumSq: 250_000,
      exactly50: 100,
      nullCount: 0,
      failCount: 0,
      uniqueValues: new Set([50]),
    };
    expect(classify(allFifty)).toBe('stub');

    // Case B: stdev clearly below 2.
    const tightCluster: PerAnalystStats = {
      count: 100,
      sum: 5100,
      sumSq: 100 * 51 * 51 + 5, // mean=51, var ≈ 0.05
      exactly50: 5,
      nullCount: 0,
      failCount: 0,
      uniqueValues: new Set([50, 51, 52]),
    };
    expect(classify(tightCluster)).toBe('stub');
  });

  it('degraded = anything in between', () => {
    // stdev ~ 3 (mid-range), pctExactly50 ~ 30%
    const s: PerAnalystStats = {
      count: 100,
      sum: 5500,
      sumSq: 100 * 55 * 55 + 900, // var = 9, stdev = 3
      exactly50: 30,
      nullCount: 0,
      failCount: 0,
      uniqueValues: new Set([50, 51, 52, 53, 54, 55]),
    };
    expect(classify(s)).toBe('degraded');
  });

  it('mean and stdev compute correctly', () => {
    const s: PerAnalystStats = {
      count: 4,
      sum: 200, // mean = 50
      sumSq: 10_200, // var = 10200/4 - 50^2 = 2550 - 2500 = 50; stdev ~ 7.07
      exactly50: 0,
      nullCount: 0,
      failCount: 0,
      uniqueValues: new Set([40, 50, 60, 50]),
    };
    expect(mean(s)).toBe(50);
    expect(stdev(s)).toBeCloseTo(Math.sqrt(50), 4);
  });
});

describe('ingestProphetResults', () => {
  it('accumulates score statistics across layers', () => {
    const results = [
      {
        layers: {
          fundamental: { score: 70, pass: true },
          catalyst: { score: 40, pass: false },
        },
      },
      {
        layers: {
          fundamental: { score: 80, pass: true },
          catalyst: { score: 50, pass: false },
        },
      },
    ];
    const stats: Record<string, PerAnalystStats> = {};
    const obs = ingestProphetResults(results, stats);
    expect(obs).toBe(4);
    expect(stats.fundamental.count).toBe(2);
    expect(stats.fundamental.sum).toBe(150);
    expect(stats.fundamental.failCount).toBe(0);
    expect(stats.catalyst.exactly50).toBe(1);
    expect(stats.catalyst.failCount).toBe(2);
  });

  it('treats null score as a null observation, not a count++', () => {
    const stats: Record<string, PerAnalystStats> = {};
    ingestProphetResults(
      [{ layers: { fundamental: { score: null, pass: false } } } as any],
      stats,
    );
    expect(stats.fundamental.count).toBe(0);
    expect(stats.fundamental.nullCount).toBe(1);
  });
});

describe('ingestTargetResults', () => {
  it('accumulates per-analyst stats from analystContributions', () => {
    const results = [
      {
        analystContributions: [
          { analyst: 'insider-analyst', score: 50 },
          { analyst: 'technical-analyst', score: 72 },
        ],
      },
      {
        analystContributions: [
          { analyst: 'insider-analyst', score: 50 },
          { analyst: 'technical-analyst', score: 68 },
        ],
      },
    ];
    const stats: Record<string, PerAnalystStats> = {};
    ingestTargetResults(results, stats);
    // Insider is stub-like: always 50.
    expect(stats['insider-analyst'].exactly50).toBe(2);
    // Technical is live-like.
    expect(stats['technical-analyst'].count).toBe(2);
    expect(stats['technical-analyst'].exactly50).toBe(0);
  });
});

describe('statsToRow', () => {
  it('rounds stats and produces a verdict', () => {
    const s: PerAnalystStats = {
      count: 100,
      sum: 5000,
      sumSq: 250000,
      exactly50: 100,
      nullCount: 0,
      failCount: 0,
      uniqueValues: new Set([50]),
    };
    const row = statsToRow('foo', s);
    expect(row.mean).toBe(50);
    expect(row.stdev).toBe(0);
    expect(row.pctExactly50).toBe(100);
    expect(row.verdict).toBe('stub');
    expect(row.uniqueValues).toBe(1);
  });

  it('exposes pctNull as fraction of (count + nullCount)', () => {
    const s = emptyStats();
    s.count = 7;
    s.nullCount = 3;
    s.sum = 350;
    s.sumSq = 17500;
    const row = statsToRow('x', s);
    expect(row.pctNull).toBe(30); // 3 / 10
  });
});
