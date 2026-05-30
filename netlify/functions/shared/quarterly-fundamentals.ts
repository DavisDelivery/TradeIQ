// Phase 6 PR-D — quarterly fundamentals series for the detail-panel
// fundamental charts.
//
// Originally (PR-A) this module made its own Polygon vX fetch to retrieve
// up to 5 years of quarterly history. Phase 4w (W2) replaced the entire
// fundamentals fetch surface with Massive Financials and added a `statements`
// bundle directly onto `getFundamentals(...)` — so the I/O here is now
// redundant.
//
// PR-D collapses this to a PURE function over the already-fetched
// `QuarterlyStatement[]`: `stock-detail` calls `getFundamentals` once for
// the metrics block and re-uses the same `statements` array for the chart
// series. No second per-ticker fetch, no remaining vX dependency, no
// stranded Polygon-key reads.
//
// The exported `QuarterlyFundamental` shape is a superset of what shipped in
// PR-A — adding `netMargin`, `freeCashFlow`, `debtToEquity`, `filingDate`,
// `fiscalQuarter`, `fiscalYear`. Existing consumers (PR-B + PR-C tests, the
// `quarterly[]` array in `/api/stock-detail`) keep working unchanged because
// the original fields (period, endDate, revenue, eps, grossMargin, opMargin)
// are preserved verbatim.

import type { QuarterlyStatement } from './data-provider';

export interface QuarterlyFundamental {
  /** Fiscal period label, e.g. "Q3 2024". */
  period: string;
  /** Period end date (YYYY-MM-DD), for sorting + axis. */
  endDate: string;
  /** SEC filing date when the row became public. */
  filingDate: string | null;
  fiscalQuarter: number | null;
  fiscalYear: number | null;
  revenue: number | null;
  eps: number | null;
  grossMargin: number | null;   // percent (44 = 44%)
  opMargin: number | null;       // percent
  /** Phase 6 PR-D additions: */
  netMargin: number | null;     // percent
  freeCashFlow: number | null;  // dollars (OCF − |capex|)
  debtToEquity: number | null;  // long-term debt + capital leases / parent equity
}

/**
 * Pure transform: take the `statements` bundle that Phase 4w's getFundamentals
 * returns (oldest-first quarterly history, up to ~5y on the Stocks Financials
 * add-on) and map each row to the panel-facing `QuarterlyFundamental` shape.
 * Returns the most recent `quarters` rows, preserving oldest-first order so
 * Recharts' x-axis paints left-to-right by time. Returns `[]` when the input
 * is empty or undefined — never throws.
 */
export function quarterlyFromStatements(
  statements: QuarterlyStatement[] | undefined,
  quarters = 20,
): QuarterlyFundamental[] {
  if (!statements || statements.length === 0) return [];
  return statements.slice(-quarters).map((s) => {
    const rev = s.income.revenue;
    const grossProfit = s.income.grossProfit;
    const opIncome = s.income.operatingIncome;
    const netIncome = s.income.netIncome;
    const longTermDebt = s.balance.longTermDebt;
    const totalEquity = s.balance.totalEquity;
    return {
      period: s.fiscalQuarter && s.fiscalYear ? `Q${s.fiscalQuarter} ${s.fiscalYear}` : (s.periodEnd || 'unknown'),
      endDate: s.periodEnd,
      filingDate: s.filingDate,
      fiscalQuarter: s.fiscalQuarter,
      fiscalYear: s.fiscalYear,
      revenue: rev,
      eps: s.income.basicEps,
      grossMargin: pctOrNull(grossProfit, rev),
      opMargin: pctOrNull(opIncome, rev),
      netMargin: pctOrNull(netIncome, rev),
      freeCashFlow: s.cashflow.freeCashFlow,
      debtToEquity: ratioOrNull(longTermDebt, totalEquity),
    };
  });
}

function pctOrNull(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return round((numerator / denominator) * 100, 1);
}

function ratioOrNull(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator === 0) return null;
  return round(numerator / denominator, 3);
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
