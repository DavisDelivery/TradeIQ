// Annual rollup for the Fundamentals chart.
//
// Reported: "All time button doesn't work and I want to look at years too."
//
// The first half was a data-layer starvation, not a UI bug — the LIVE
// statement fetch asked for 8 quarters while the chart offered 5Y (20) and
// ALL, so both buttons sliced the same 8 rows and rendered identically.
//
// This file covers the second half, where the real correctness risk is: EVERY
// SERIES AGGREGATES DIFFERENTLY. Summing a margin is meaningless, averaging
// one is wrong, and summing a debt ratio is nonsense. A rollup that got any of
// those wrong would still draw a perfectly plausible chart.

import { describe, it, expect } from 'vitest';
import { toFiscalYears } from '../FundamentalsChart.jsx';

/** Four quarters of one fiscal year. */
const fy = (year, rows) =>
  rows.map((r, i) => ({
    period: `Q${i + 1} ${year}`,
    endDate: `${year}-${String(3 * (i + 1)).padStart(2, '0')}-28`,
    filingDate: `${year}-${String(3 * (i + 1)).padStart(2, '0')}-30`,
    fiscalYear: year,
    fiscalQuarter: i + 1,
    revenue: null, eps: null, grossMargin: null, opMargin: null,
    netMargin: null, freeCashFlow: null, debtToEquity: null,
    ...r,
  }));

describe('flows are summed', () => {
  const rows = fy(2025, [
    { revenue: 100, eps: 1, freeCashFlow: 10 },
    { revenue: 200, eps: 2, freeCashFlow: 20 },
    { revenue: 300, eps: 3, freeCashFlow: 30 },
    { revenue: 400, eps: 4, freeCashFlow: 40 },
  ]);

  it('adds revenue, EPS and free cash flow across the year', () => {
    const [y] = toFiscalYears(rows);
    expect(y.revenue).toBe(1000);
    expect(y.eps).toBe(10);
    expect(y.freeCashFlow).toBe(100);
  });

  it('labels the year and dates it to the LAST quarter', () => {
    const [y] = toFiscalYears(rows);
    expect(y.period).toBe('FY 2025');
    expect(y.endDate).toBe('2025-12-28');
  });

  it('returns null rather than a short sum when a quarter is missing data', () => {
    // Three quarters of revenue labelled as a year is understated by a
    // quarter and draws as a decline that did not happen.
    const gappy = fy(2025, [
      { revenue: 100 }, { revenue: 200 }, { revenue: null }, { revenue: 400 },
    ]);
    expect(toFiscalYears(gappy)[0].revenue).toBeNull();
  });
});

describe('margins are revenue-weighted, not averaged', () => {
  // One huge low-margin quarter and three tiny high-margin ones. A plain mean
  // says ~65%; the true annual margin is dominated by the big quarter.
  const skewed = fy(2025, [
    { revenue: 1000, grossMargin: 20, opMargin: 10, netMargin: 5 },
    { revenue: 10, grossMargin: 80, opMargin: 70, netMargin: 60 },
    { revenue: 10, grossMargin: 80, opMargin: 70, netMargin: 60 },
    { revenue: 10, grossMargin: 80, opMargin: 70, netMargin: 60 },
  ]);

  it('weights by revenue', () => {
    const [y] = toFiscalYears(skewed);
    // gross: (20*1000 + 80*30) / 1030 = 22400/1030 = 21.7476
    // op:    (10*1000 + 70*30) / 1030 = 12100/1030 = 11.7476
    // net:   ( 5*1000 + 60*30) / 1030 =  6800/1030 =  6.6019
    expect(y.grossMargin).toBeCloseTo(21.7476, 3);
    expect(y.opMargin).toBeCloseTo(11.7476, 3);
    expect(y.netMargin).toBeCloseTo(6.6019, 3);
  });

  it('is nowhere near the naive mean, which is the bug being prevented', () => {
    const [y] = toFiscalYears(skewed);
    const naive = (20 + 80 + 80 + 80) / 4; // 65
    expect(Math.abs(y.grossMargin - naive)).toBeGreaterThan(40);
  });

  it('equals aggregate profit over aggregate revenue exactly', () => {
    // The property that makes weighting correct rather than approximate:
    // Σ(margin·rev)/Σ(rev) === Σ(profit)/Σ(rev).
    const [y] = toFiscalYears(skewed);
    const profit = skewed.reduce((a, r) => a + (r.grossMargin / 100) * r.revenue, 0);
    const revenue = skewed.reduce((a, r) => a + r.revenue, 0);
    expect(y.grossMargin).toBeCloseTo((profit / revenue) * 100, 10);
  });

  it('ignores quarters with no revenue to weight by, rather than dividing by zero', () => {
    const noRev = fy(2025, [
      { revenue: null, grossMargin: 50 }, { revenue: 0, grossMargin: 50 },
      { revenue: null, grossMargin: 50 }, { revenue: null, grossMargin: 50 },
    ]);
    expect(toFiscalYears(noRev)[0].grossMargin).toBeNull();
  });
});

describe('debt/equity is a balance-sheet reading, not a flow', () => {
  const rows = fy(2025, [
    { debtToEquity: 1.0 }, { debtToEquity: 2.0 },
    { debtToEquity: 3.0 }, { debtToEquity: 0.5 },
  ]);

  it('takes the year-end quarter, not the sum or the mean', () => {
    const [y] = toFiscalYears(rows);
    expect(y.debtToEquity).toBe(0.5);   // last quarter
    expect(y.debtToEquity).not.toBe(6.5);   // sum
    expect(y.debtToEquity).not.toBe(1.625); // mean
  });

  it('uses the chronologically last quarter even when input order is scrambled', () => {
    const shuffled = [rows[2], rows[0], rows[3], rows[1]];
    expect(toFiscalYears(shuffled)[0].debtToEquity).toBe(0.5);
  });
});

describe('incomplete fiscal years are dropped, not drawn short', () => {
  it('omits a year with fewer than four quarters', () => {
    const partial = [
      ...fy(2024, [{ revenue: 100 }, { revenue: 100 }, { revenue: 100 }, { revenue: 100 }]),
      ...fy(2025, [{ revenue: 100 }, { revenue: 100 }, { revenue: 100 }]).slice(0, 3),
    ];
    const out = toFiscalYears(partial);
    expect(out.map((y) => y.fiscalYear)).toEqual([2024]);
  });

  it('a three-quarter year would have drawn as a 25% collapse', () => {
    // The reason for the rule, stated as a test: same quarterly run-rate,
    // but the partial year sums to 3/4 of the full one.
    const partial = fy(2025, [{ revenue: 100 }, { revenue: 100 }, { revenue: 100 }]).slice(0, 3);
    expect(toFiscalYears(partial)).toEqual([]);
  });

  it('sorts years ascending so the axis reads left to right', () => {
    const many = [
      ...fy(2026, [{ revenue: 4 }, { revenue: 4 }, { revenue: 4 }, { revenue: 4 }]),
      ...fy(2024, [{ revenue: 1 }, { revenue: 1 }, { revenue: 1 }, { revenue: 1 }]),
      ...fy(2025, [{ revenue: 2 }, { revenue: 2 }, { revenue: 2 }, { revenue: 2 }]),
    ];
    expect(toFiscalYears(many).map((y) => y.fiscalYear)).toEqual([2024, 2025, 2026]);
  });
});

describe('junk in, nothing out', () => {
  it('skips rows with no fiscal year rather than inventing one', () => {
    const noFy = fy(2025, [{ revenue: 1 }, { revenue: 1 }, { revenue: 1 }, { revenue: 1 }])
      .map((r) => ({ ...r, fiscalYear: null }));
    expect(toFiscalYears(noFy)).toEqual([]);
  });

  it('handles an empty input', () => {
    expect(toFiscalYears([])).toEqual([]);
  });
});
