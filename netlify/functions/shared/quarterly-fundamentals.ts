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


/**
 * FUND-1 (2026-08-07) — roll quarters up into fiscal years.
 *
 * The aggregation rule DIFFERS BY METRIC TYPE, and getting it uniform would
 * be silently wrong:
 *
 *   FLOWS (revenue, EPS, free cash flow) SUM across the four quarters. An
 *   average would report a quarterly run-rate under an annual label.
 *
 *   MARGINS are REVENUE-WEIGHTED, not simple averages. margin_q =
 *   profit_q / revenue_q, so the true annual margin is
 *   Σprofit / Σrevenue = Σ(margin_q · revenue_q) / Σrevenue_q. A plain mean
 *   over-weights small quarters — for a seasonal retailer whose Q4 is half
 *   the year, the unweighted number can be off by hundreds of basis points.
 *
 *   DEBT-TO-EQUITY is a BALANCE-SHEET ratio, a snapshot rather than a flow.
 *   It takes the LAST quarter of the year. Summing it would be meaningless
 *   and averaging it would smooth away the year-end position the user
 *   actually wants to see.
 *
 * PARTIAL YEARS ARE DROPPED. A fiscal year with fewer than four reported
 * quarters is not an annual figure; rendering one next to complete years
 * invites reading a stub as a collapse in revenue.
 */
export function annualFromQuarterly(
  quarters: QuarterlyFundamental[] | undefined,
): QuarterlyFundamental[] {
  if (!quarters || quarters.length === 0) return [];

  const byYear = new Map<number, QuarterlyFundamental[]>();
  for (const q of quarters) {
    const fy = q.fiscalYear;
    if (typeof fy !== 'number' || !Number.isFinite(fy)) continue;
    const arr = byYear.get(fy) ?? [];
    arr.push(q);
    byYear.set(fy, arr);
  }

  const out: QuarterlyFundamental[] = [];
  for (const [fy, rows] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    if (rows.length < 4) continue; // partial year — not an annual number
    const ordered = [...rows].sort((a, b) =>
      String(a.endDate ?? '').localeCompare(String(b.endDate ?? '')),
    );
    const last = ordered[ordered.length - 1];

    out.push({
      period: `FY ${fy}`,
      endDate: last.endDate,
      filingDate: last.filingDate,
      fiscalQuarter: null,        // an annual row has no quarter
      fiscalYear: fy,
      revenue: sum(ordered.map((r) => r.revenue)),
      eps: sum(ordered.map((r) => r.eps)),
      freeCashFlow: sum(ordered.map((r) => r.freeCashFlow)),
      grossMargin: revenueWeighted(ordered, (r) => r.grossMargin),
      opMargin: revenueWeighted(ordered, (r) => r.opMargin),
      netMargin: revenueWeighted(ordered, (r) => r.netMargin),
      debtToEquity: last.debtToEquity,  // point-in-time, year-end
    });
  }
  return out;
}

/** Sum, or null when NOTHING was reported — never a fabricated zero. */
function sum(vals: Array<number | null>): number | null {
  const nums = vals.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
}

/** Revenue-weighted mean of a margin series. See the header for why. */
function revenueWeighted(
  rows: QuarterlyFundamental[],
  pick: (r: QuarterlyFundamental) => number | null,
): number | null {
  let num = 0;
  let den = 0;
  for (const r of rows) {
    const m = pick(r);
    const rev = r.revenue;
    if (typeof m !== 'number' || !Number.isFinite(m)) continue;
    if (typeof rev !== 'number' || !Number.isFinite(rev) || rev <= 0) continue;
    num += m * rev;
    den += rev;
  }
  return den > 0 ? num / den : null;
}
