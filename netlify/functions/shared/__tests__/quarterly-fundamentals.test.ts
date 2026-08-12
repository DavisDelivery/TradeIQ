// Phase 6 PR-D — quarterlyFromStatements pure transform.

import { describe, it, expect } from 'vitest';
import { quarterlyFromStatements } from '../quarterly-fundamentals';
import type { QuarterlyStatement } from '../data-provider';

function q(periodEnd: string, fy: number, fq: number, overrides: Partial<QuarterlyStatement> = {}): QuarterlyStatement {
  return {
    periodEnd,
    filingDate: null,
    fiscalQuarter: fq,
    fiscalYear: fy,
    income: { revenue: 1000, grossProfit: 440, operatingIncome: 300, netIncome: 240, basicEps: 2.4, ebitda: 320 },
    balance: { totalAssets: 5000, totalCurrentAssets: 2000, totalCurrentLiabilities: 1000, cashAndEquivalents: 1500, inventories: 100, longTermDebt: 600, debtCurrent: 50, totalEquity: 2000 },
    cashflow: { operatingCashFlow: 280, capitalExpenditure: -30, freeCashFlow: 250, dividendsPaid: -10 },
    ...overrides,
  };
}

describe('quarterlyFromStatements', () => {
  it('returns [] for undefined / empty input', () => {
    expect(quarterlyFromStatements(undefined)).toEqual([]);
    expect(quarterlyFromStatements([])).toEqual([]);
  });

  it('maps each statement to a panel-facing row, preserving order', () => {
    const stmts = [
      q('2024-03-31', 2024, 1),
      q('2024-06-30', 2024, 2),
      q('2024-09-30', 2024, 3),
    ];
    const out = quarterlyFromStatements(stmts);
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({
      period: 'Q1 2024', endDate: '2024-03-31', fiscalQuarter: 1, fiscalYear: 2024,
      revenue: 1000, eps: 2.4,
      grossMargin: 44, opMargin: 30, netMargin: 24,
      freeCashFlow: 250, debtToEquity: 0.3,
    });
    expect(out[2].period).toBe('Q3 2024');
  });

  it('takes only the most recent `quarters` rows (default 20)', () => {
    const stmts = Array.from({ length: 25 }, (_, i) => q(`202${i % 10}-03-31`, 2020 + i, 1));
    const out = quarterlyFromStatements(stmts, 5);
    expect(out).toHaveLength(5);
    // slice(-5) → indices 20..24 — newest five
    expect(out[0].fiscalYear).toBe(2040);
    expect(out[4].fiscalYear).toBe(2044);
  });

  it('renders nulls (not zeros) when source line items are null', () => {
    const stmt = q('2024-03-31', 2024, 1, {
      income: { revenue: null, grossProfit: null, operatingIncome: null, netIncome: null, basicEps: null, ebitda: null },
      balance: { totalAssets: null, totalCurrentAssets: null, totalCurrentLiabilities: null, cashAndEquivalents: null, inventories: null, longTermDebt: null, debtCurrent: null, totalEquity: null },
      cashflow: { operatingCashFlow: null, capitalExpenditure: null, freeCashFlow: null, dividendsPaid: null },
    });
    const [row] = quarterlyFromStatements([stmt]);
    expect(row.revenue).toBeNull();
    expect(row.eps).toBeNull();
    expect(row.grossMargin).toBeNull();
    expect(row.opMargin).toBeNull();
    expect(row.netMargin).toBeNull();
    expect(row.freeCashFlow).toBeNull();
    expect(row.debtToEquity).toBeNull();
  });

  it('guards against divide-by-zero (revenue=0 → margins null, equity=0 → D/E null)', () => {
    const stmt = q('2024-03-31', 2024, 1, {
      income: { revenue: 0, grossProfit: 0, operatingIncome: 0, netIncome: 0, basicEps: 0, ebitda: null },
      balance: { totalAssets: 100, totalCurrentAssets: 50, totalCurrentLiabilities: 25, cashAndEquivalents: 10, inventories: 5, longTermDebt: 30, debtCurrent: 0, totalEquity: 0 },
    });
    const [row] = quarterlyFromStatements([stmt]);
    expect(row.grossMargin).toBeNull();
    expect(row.opMargin).toBeNull();
    expect(row.netMargin).toBeNull();
    expect(row.debtToEquity).toBeNull();
  });

  it('falls back to periodEnd as label when fiscal labels are missing', () => {
    const stmt = q('2024-12-31', 2024, 1, { fiscalQuarter: null, fiscalYear: null });
    const [row] = quarterlyFromStatements([stmt]);
    expect(row.period).toBe('2024-12-31');
  });
});

// FUND-1 (2026-08-07) — annual rollup.
//
// Reported bug: "ALL doesn't work, and I want a yearly button." ALL was not
// broken — the provider only ever returned 8 quarters, so 5Y and ALL drew
// the same 8 bars. The provider limit is now 40; these tests pin the annual
// aggregation, whose rules differ by metric type in ways a uniform average
// would silently get wrong.
import { annualFromQuarterly } from '../quarterly-fundamentals';

function aq(fy: number, fq: number, over: Record<string, unknown> = {}) {
  return {
    period: `Q${fq} ${fy}`,
    endDate: `${fy}-${String(fq * 3).padStart(2, '0')}-30`,
    filingDate: null,
    fiscalQuarter: fq,
    fiscalYear: fy,
    revenue: 100,
    eps: 1,
    grossMargin: 40,
    opMargin: 20,
    netMargin: 10,
    freeCashFlow: 50,
    debtToEquity: 1.0,
    ...over,
  } as any;
}

describe('annualFromQuarterly', () => {
  it('SUMS flow metrics across the four quarters', () => {
    const y = annualFromQuarterly([aq(2025, 1), aq(2025, 2), aq(2025, 3), aq(2025, 4)]);
    expect(y).toHaveLength(1);
    expect(y[0].revenue).toBe(400);
    expect(y[0].eps).toBe(4);
    expect(y[0].freeCashFlow).toBe(200);
    expect(y[0].period).toBe('FY 2025');
    expect(y[0].fiscalQuarter).toBeNull();
  });

  it('REVENUE-WEIGHTS margins rather than averaging them', () => {
    // Seasonal retailer: Q4 is 70% of the year at a lower margin. A plain
    // mean says 40%; the truth is much closer to Q4's 20%.
    const rows = [
      aq(2025, 1, { revenue: 100, grossMargin: 60 }),
      aq(2025, 2, { revenue: 100, grossMargin: 60 }),
      aq(2025, 3, { revenue: 100, grossMargin: 60 }),
      aq(2025, 4, { revenue: 700, grossMargin: 20 }),
    ];
    const y = annualFromQuarterly(rows);
    const plainMean = (60 + 60 + 60 + 20) / 4; // 50 — wrong
    const weighted = (60 * 300 + 20 * 700) / 1000; // 32 — right
    expect(y[0].grossMargin).toBeCloseTo(weighted, 8);
    expect(y[0].grossMargin).not.toBeCloseTo(plainMean, 1);
  });

  it('takes YEAR-END debt/equity, not a sum or an average', () => {
    // A balance-sheet ratio is a snapshot. Summing it is meaningless and
    // averaging hides the year-end position the user wants.
    const y = annualFromQuarterly([
      aq(2025, 1, { debtToEquity: 3 }),
      aq(2025, 2, { debtToEquity: 3 }),
      aq(2025, 3, { debtToEquity: 3 }),
      aq(2025, 4, { debtToEquity: 0.5 }),
    ]);
    expect(y[0].debtToEquity).toBe(0.5);
  });

  it('DROPS partial years — a 2-quarter stub is not an annual figure', () => {
    // Rendering one beside complete years reads as a revenue collapse.
    const y = annualFromQuarterly([
      aq(2024, 1), aq(2024, 2), aq(2024, 3), aq(2024, 4),
      aq(2025, 1), aq(2025, 2),
    ]);
    expect(y.map((r) => r.fiscalYear)).toEqual([2024]);
  });

  it('returns null rather than 0 when a metric was never reported', () => {
    const y = annualFromQuarterly([
      aq(2025, 1, { freeCashFlow: null }), aq(2025, 2, { freeCashFlow: null }),
      aq(2025, 3, { freeCashFlow: null }), aq(2025, 4, { freeCashFlow: null }),
    ]);
    expect(y[0].freeCashFlow).toBeNull();
    expect(y[0].revenue).toBe(400);
  });

  it('orders years oldest-first and handles empty input', () => {
    const y = annualFromQuarterly([
      aq(2025, 1), aq(2025, 2), aq(2025, 3), aq(2025, 4),
      aq(2024, 1), aq(2024, 2), aq(2024, 3), aq(2024, 4),
    ]);
    expect(y.map((r) => r.fiscalYear)).toEqual([2024, 2025]);
    expect(annualFromQuarterly([])).toEqual([]);
    expect(annualFromQuarterly(undefined)).toEqual([]);
  });
});
