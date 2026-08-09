// P1-S2 — opportunistic insider clusters.

import { describe, it, expect } from 'vitest';
import {
  openMarketBuys,
  routineVerdict,
  findConvictionClusters,
  scoreCluster,
  dollarsOf,
  MIN_BUYERS,
  MIN_CLUSTER_DOLLARS,
  BOOST_POINTS,
  MAX_SCORE,
} from '../insider-conviction';
import type { InsiderTransaction } from '../insider-provider';

const tx = (
  name: string,
  transactionDate: string,
  share: number,
  price: number,
  transactionCode = 'P',
  filingDate = transactionDate,
): InsiderTransaction => ({
  name, share, change: share, transactionDate, filingDate,
  transactionPrice: price, transactionCode, position: '',
});

describe('openMarketBuys — code P only', () => {
  it('keeps purchases and drops awards, exercises and withholdings', () => {
    // Including 'A' turns a conviction screen into a compensation-calendar
    // screen, which is the routine half of the CMP split by another route.
    const txns = [
      tx('A', '2026-08-01', 100, 50, 'P'),
      tx('B', '2026-08-01', 100, 50, 'A'),
      tx('C', '2026-08-01', 100, 50, 'M'),
      tx('D', '2026-08-01', 100, 50, 'F'),
      tx('E', '2026-08-01', -100, 50, 'S'),
    ];
    expect(openMarketBuys(txns).map((t) => t.name)).toEqual(['A']);
  });

  it('drops rows with an unusable price or a malformed date', () => {
    expect(openMarketBuys([tx('A', '2026-08-01', 100, 0)])).toEqual([]);
    expect(openMarketBuys([tx('A', 'not-a-date', 100, 5)])).toEqual([]);
  });

  it('computes dollars from absolute shares', () => {
    expect(dollarsOf(tx('A', '2026-08-01', 100, 12.5))).toBe(1250);
  });
});

describe('routineVerdict — the Cohen-Malloy-Pomorski filter', () => {
  const history = (years: number[], name = 'HABIT', month = '03') =>
    years.map((y) => tx(name, `${y}-${month}-15`, 100, 50));

  it('marks a buyer routine only when ALL THREE prior years match the month', () => {
    const buy = tx('HABIT', '2026-03-10', 100, 50);
    const h = [...history([2023, 2024, 2025]), buy];
    const v = routineVerdict(buy, h);
    expect(v.routine).toBe(true);
    expect(v.matchedYears.sort()).toEqual([2023, 2024, 2025]);
  });

  it('does NOT mark routine on two of three years', () => {
    // Two Marches is not yet a schedule; treating it as one throws away real
    // signal in order to look strict.
    const buy = tx('HABIT', '2026-03-10', 100, 50);
    const v = routineVerdict(buy, [...history([2024, 2025]), buy]);
    expect(v.routine).toBe(false);
    expect(v.matchedYears.sort()).toEqual([2024, 2025]);
  });

  it('is month-specific — buying every year in a DIFFERENT month is not routine', () => {
    const buy = tx('X', '2026-03-10', 100, 50);
    const h = [
      tx('X', '2025-06-10', 100, 50),
      tx('X', '2024-09-10', 100, 50),
      tx('X', '2023-01-10', 100, 50),
      buy,
    ];
    expect(routineVerdict(buy, h).routine).toBe(false);
  });

  it('is per-person — another insider\'s habit does not taint this buyer', () => {
    const buy = tx('FRESH', '2026-03-10', 100, 50);
    const v = routineVerdict(buy, [...history([2023, 2024, 2025], 'HABIT'), buy]);
    expect(v.routine).toBe(false);
  });

  it('reports UNDECIDABLE when history is too short to answer', () => {
    // The silent failure this guards: with only 180 days of history nobody
    // can ever be marked routine, the filter passes everything, and the
    // board simply looks like it has more candidates than it should.
    const buy = tx('X', '2026-03-10', 100, 50);
    const v = routineVerdict(buy, [tx('X', '2026-01-05', 100, 50), buy]);
    expect(v.decidable).toBe(false);
    expect(v.routine).toBe(false);
  });

  it('is decidable when history reaches past the lookback', () => {
    const buy = tx('X', '2026-03-10', 100, 50);
    const v = routineVerdict(buy, [tx('X', '2022-01-05', 100, 50), buy]);
    expect(v.decidable).toBe(true);
  });
});

describe('findConvictionClusters — the gates', () => {
  const deepHistory = (name: string) => tx(name, '2020-01-02', 1, 50);

  it('finds a qualifying two-buyer cluster inside ten days', () => {
    const txns = [
      tx('A', '2026-08-01', 3000, 50), // $150k
      tx('B', '2026-08-05', 2000, 50), // $100k -> $250k total
      deepHistory('A'), deepHistory('B'),
    ];
    const [c] = findConvictionClusters(txns);
    expect(c).toBeTruthy();
    expect(c.buyerCount).toBe(2);
    expect(c.dollars).toBeCloseTo(250_000, 6);
  });

  it('rejects a single buyer however large', () => {
    const txns = [tx('A', '2026-08-01', 100_000, 50), deepHistory('A')];
    expect(findConvictionClusters(txns)).toEqual([]);
  });

  it('rejects two buyers more than ten days apart', () => {
    const txns = [
      tx('A', '2026-08-01', 3000, 50),
      tx('B', '2026-08-20', 3000, 50),
      deepHistory('A'), deepHistory('B'),
    ];
    expect(findConvictionClusters(txns)).toEqual([]);
  });

  it('rejects a cluster below the dollar floor', () => {
    const txns = [
      tx('A', '2026-08-01', 100, 50), tx('B', '2026-08-02', 100, 50),
      deepHistory('A'), deepHistory('B'),
    ];
    expect(findConvictionClusters(txns)).toEqual([]);
    expect(MIN_CLUSTER_DOLLARS).toBe(200_000);
  });

  it('counts DISTINCT insiders — one person buying twice is not a cluster', () => {
    const txns = [
      tx('A', '2026-08-01', 3000, 50), tx('A', '2026-08-03', 3000, 50),
      deepHistory('A'),
    ];
    expect(findConvictionClusters(txns)).toEqual([]);
    expect(MIN_BUYERS).toBe(2);
  });

  it('removes routine buyers BEFORE the gates, not after', () => {
    // The ordering is the point: filtering afterwards would let a habitual
    // buyer supply the second body that makes one discretionary purchase
    // look like a cluster.
    const routineHistory = [2023, 2024, 2025].map((y) => tx('HABIT', `${y}-08-15`, 100, 50));
    const txns = [
      tx('REAL', '2026-08-14', 4000, 50),  // $200k on its own
      tx('HABIT', '2026-08-15', 4000, 50), // routine — must not count
      ...routineHistory,
      deepHistory('REAL'),
    ];
    const clusters = findConvictionClusters(txns);
    expect(clusters).toEqual([]); // one real buyer left, so no cluster
  });

  it('reports which buyers were dropped as routine', () => {
    const routineHistory = [2023, 2024, 2025].map((y) => tx('HABIT', `${y}-08-15`, 100, 50));
    const txns = [
      tx('R1', '2026-08-14', 4000, 50),
      tx('R2', '2026-08-15', 4000, 50),
      tx('HABIT', '2026-08-15', 4000, 50),
      ...routineHistory, deepHistory('R1'), deepHistory('R2'),
    ];
    const [c] = findConvictionClusters(txns);
    expect(c.buyers.sort()).toEqual(['R1', 'R2']);
    expect(c.droppedRoutineBuyers).toContain('HABIT');
  });

  it('surfaces the last filing date — the earliest we could have acted', () => {
    const txns = [
      tx('A', '2026-08-01', 3000, 50, 'P', '2026-08-03'),
      tx('B', '2026-08-05', 2000, 50, 'P', '2026-08-07'),
      deepHistory('A'), deepHistory('B'),
    ];
    expect(findConvictionClusters(txns)[0].lastFilingDate).toBe('2026-08-07');
  });

  it('orders clusters strongest-first', () => {
    const txns = [
      tx('A', '2026-01-05', 3000, 50), tx('B', '2026-01-06', 3000, 50),
      tx('C', '2026-06-05', 30_000, 50), tx('D', '2026-06-06', 30_000, 50),
      deepHistory('A'), deepHistory('B'), deepHistory('C'), deepHistory('D'),
    ];
    const cs = findConvictionClusters(txns);
    expect(cs.length).toBeGreaterThanOrEqual(2);
    expect(cs[0].dollars).toBeGreaterThan(cs[1].dollars);
  });
});

describe('scoreCluster — boosts reorder, they never admit', () => {
  const base = {
    windowStart: '2026-08-01', windowEnd: '2026-08-05',
    buyers: ['A', 'B'], buyerCount: 2, dollars: MIN_CLUSTER_DOLLARS,
    lastFilingDate: '2026-08-06', droppedRoutineBuyers: [], undecidableBuyers: [],
  };

  it('scores a minimum qualifying cluster low but non-zero', () => {
    const s = scoreCluster(base);
    expect(s.base).toBeGreaterThan(0);
    expect(s.boosts).toEqual([]);
  });

  it('rewards breadth with saturation', () => {
    const two = scoreCluster({ ...base, buyerCount: 2 }).base;
    const four = scoreCluster({ ...base, buyerCount: 4 }).base;
    const eight = scoreCluster({ ...base, buyerCount: 8 }).base;
    expect(four).toBeGreaterThan(two);
    // Without saturation one wide board sweep would dominate the screen.
    expect(eight - four).toBeLessThan(four - two + 1);
  });

  it('rewards size on a log scale', () => {
    const a = scoreCluster({ ...base, dollars: 2_000_000 }).base;
    const b = scoreCluster({ ...base, dollars: 20_000_000 }).base;
    expect(b - a).toBeLessThan(a - scoreCluster(base).base + 1);
  });

  it('applies each boost exactly once', () => {
    const s = scoreCluster(base, {
      roles: ['Director', 'CFO'],
      maxBuyFractionOfHoldings: 0.25,
      trailing12mPct: -10,
      universeMedian12mPct: 5,
      buybackAuthFraction: 0.07,
    });
    expect(s.boosts.map((b) => b.name).sort()).toEqual([
      'bottom-half-12m', 'buy>=10%-of-holdings', 'buyback>=5%', 'cfo-buying',
    ]);
    expect(s.score).toBe(
      Math.min(MAX_SCORE, s.base + BOOST_POINTS.cfo + BOOST_POINTS.bigRelativeBuy +
        BOOST_POINTS.priorWeakness + BOOST_POINTS.buyback),
    );
  });

  it('does not boost on a near-miss threshold', () => {
    const s = scoreCluster(base, {
      maxBuyFractionOfHoldings: 0.09,
      buybackAuthFraction: 0.049,
      trailing12mPct: 10, universeMedian12mPct: 5,
    });
    expect(s.boosts).toEqual([]);
  });

  it('treats missing context as no boost rather than as a penalty', () => {
    expect(scoreCluster(base, {}).score).toBe(scoreCluster(base).score);
    expect(scoreCluster(base, { trailing12mPct: null, universeMedian12mPct: null }).boosts)
      .toEqual([]);
  });

  it('caps at the DERIVED ceiling, which is not 100', () => {
    const s = scoreCluster(
      { ...base, buyerCount: 20, dollars: 500_000_000 },
      { roles: ['CFO'], maxBuyFractionOfHoldings: 1, trailing12mPct: -50,
        universeMedian12mPct: 5, buybackAuthFraction: 0.5 },
    );
    expect(s.score).toBe(MAX_SCORE);
    // Pinned so nobody re-documents the scale as 0-100: the components top
    // out well below it, and the gap misreads as a mediocre score.
    expect(MAX_SCORE).toBe(87);
    expect(MAX_SCORE).toBeLessThan(100);
  });
});
