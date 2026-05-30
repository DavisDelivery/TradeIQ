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
