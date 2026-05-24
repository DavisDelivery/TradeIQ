// Phase 6 W1 — quarterly fundamentals history for the detail-panel
// fundamental charts (Phase 6 W4: revenue / EPS / margins over ~5 years).
//
// `getFundamentals` (data-provider.ts) returns a single normalized snapshot;
// the charts need a time series. This is a read-only sibling accessor over the
// same already-wired Polygon financials endpoint — it does NOT modify or
// refactor `getFundamentals`.
//
// **Phase 4w coordination:** the Polygon `vX/reference/financials` endpoint is
// being migrated by Phase 4w (Massive Financials VX sunset). This accessor
// reads it independently and fully gracefully — any non-OK response or parse
// failure yields an empty series, so /api/stock-detail always returns a valid
// shape. When 4w lands the new fundamentals source, repoint this one function.

import {
  PolygonFinancialsResponseSchema,
  parseOrFallback,
} from './schemas';

const POLYGON = 'https://api.polygon.io';

export interface QuarterlyFundamental {
  /** Fiscal period label, e.g. "Q3 2024". */
  period: string;
  /** Period end date (YYYY-MM-DD), for sorting + axis. */
  endDate: string;
  revenue: number | null;
  eps: number | null;
  grossMargin: number | null; // percent
  opMargin: number | null; // percent
}

function num(v: unknown): number | undefined {
  if (v && typeof v === 'object' && 'value' in v) {
    const n = Number((v as { value: unknown }).value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'number') return v;
  return undefined;
}

/**
 * Fetch up to `quarters` quarterly filings (default 20 ≈ 5y), newest-first
 * from Polygon, and map each to revenue / EPS / gross + operating margin.
 *
 * Returns oldest-first (chart-ready). Empty array on any failure — never
 * throws.
 */
export async function getQuarterlyFundamentals(
  ticker: string,
  quarters = 20,
): Promise<QuarterlyFundamental[]> {
  const key = process.env.POLYGON_API_KEY;
  if (!key) return [];
  try {
    const url = `${POLYGON}/vX/reference/financials?ticker=${encodeURIComponent(ticker)}&limit=${quarters}&timeframe=quarterly&order=desc&apiKey=${key}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = parseOrFallback(
      PolygonFinancialsResponseSchema,
      await res.json(),
      { provider: 'polygon', endpoint: 'financials:quarterly-history', ticker },
      { results: [] },
    );
    const rows = (data.results ?? []) as Array<{
      end_date?: string;
      fiscal_period?: string;
      fiscal_year?: string;
      financials?: { income_statement?: Record<string, unknown> };
    }>;

    const mapped: QuarterlyFundamental[] = rows.map((r) => {
      const inc = r.financials?.income_statement ?? {};
      const revenue = num(inc.revenues);
      const eps = num(inc.basic_earnings_per_share);
      const grossProfit = num(inc.gross_profit);
      const opIncome = num(inc.operating_income_loss);
      const grossMargin =
        revenue !== undefined && revenue !== 0 && grossProfit !== undefined
          ? round((grossProfit / revenue) * 100, 1)
          : null;
      const opMargin =
        revenue !== undefined && revenue !== 0 && opIncome !== undefined
          ? round((opIncome / revenue) * 100, 1)
          : null;
      const fp = r.fiscal_period ?? '';
      const fy = r.fiscal_year ?? (r.end_date ? r.end_date.slice(0, 4) : '');
      return {
        period: [fp, fy].filter(Boolean).join(' ') || (r.end_date ?? 'unknown'),
        endDate: r.end_date ?? '',
        revenue: revenue ?? null,
        eps: eps ?? null,
        grossMargin,
        opMargin,
      };
    });

    // Oldest-first for charting. Sort by endDate when present.
    return mapped
      .filter((m) => m.endDate)
      .sort((a, b) => a.endDate.localeCompare(b.endDate));
  } catch {
    return [];
  }
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}
