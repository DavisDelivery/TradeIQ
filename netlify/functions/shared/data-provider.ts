// Unified market data provider — Polygon (bars, fundamentals, news, snapshots)
// + Finnhub (earnings, recommendations) + FRED (macro rates, VIX).

import {
  PolygonAggregatesResponseSchema,
  PolygonNewsResponseSchema,
  FinnhubEarningsCalendarResponseSchema,
  FinnhubEarningsHistoryResponseSchema,
  FinnhubInsiderTxResponseSchema,
  FinnhubRecommendationResponseSchema,
  FredObservationsResponseSchema,
  parseOrFallback,
  type MassiveRatiosResult,
  type MassiveIncomeStatement,
  type MassiveBalanceSheet,
  type MassiveCashFlow,
} from './schemas';
import { snapshotBeforeDate } from './snapshot-store';
import { fetchWithRateLimit, getFinnhubBucket } from './rate-limiter';
import { liveCacheGet, liveCacheSet, type LiveCacheKey } from './provider-live-cache';
import {
  fetchRatiosWithStatus,
  fetchIncomeStatementsWithStatus,
  fetchBalanceSheetsWithStatus,
  fetchCashFlowStatementsWithStatus,
  getIncomeStatementsPit,
  getBalanceSheetsPit,
  getCashFlowStatementsPit,
  makeLiveCache,
} from './massive-fundamentals';

const POLYGON = 'https://api.polygon.io';
const FINNHUB = 'https://finnhub.io/api/v1';
const FRED = 'https://api.stlouisfed.org/fred';

function polygonKey(): string {
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error('POLYGON_API_KEY not set');
  return k;
}
function finnhubKey(): string {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error('FINNHUB_API_KEY not set');
  return k;
}
function fredKey(): string {
  const k = process.env.FRED_API_KEY;
  if (!k) throw new Error('FRED_API_KEY not set');
  return k;
}

// ---------------------------------------------------------------------------
// Bars
// ---------------------------------------------------------------------------

export interface Bar {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
  vw?: number;
  n?: number;
}

// PIT-safe: daily OHLCV does not revise after publication. Calling
// for past ranges today returns the same bars that were true on those
// dates. Delisted-ticker retention verified at audit time:
//   - FRBA (delisted 2023): returns full pre-delisting history.
//   - FRC  (First Republic, delisted 2023): same.
//   - LEHMQ (delisted 2008): NOT_AUTHORIZED on the current Polygon plan
//     tier — backtests requiring 2008 data will need a tier upgrade.
// PIT-cacheable: keyed by (ticker, from, to).
// See docs/POINT_IN_TIME_AUDIT.md for the full data-class matrix.
export async function getDailyBars(
  ticker: string,
  from: string,
  to: string,
): Promise<Bar[]> {
  const url = `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${polygonKey()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon bars ${ticker}: ${res.status}`);
  const data = parseOrFallback(
    PolygonAggregatesResponseSchema,
    await res.json(),
    { provider: 'polygon', endpoint: 'aggregates', ticker },
    { results: [] },
  );
  return (data.results ?? []) as Bar[];
}

/**
 * DESK-1 W1 — intraday aggregates for the 1D/5D chart ranges.
 *
 * Status-aware because intraday resolution is Polygon PLAN-GATED: a
 * plan without minute aggregates returns 403/NOT_AUTHORIZED. Callers
 * (price-history 1D/5D) must degrade gracefully — daily bars +
 * `intradayUnavailable: true` — never error the chart.
 *
 * NOT PIT-relevant: intraday bars are a live-UI concern only; no scan
 * or backtest path consumes them.
 */
export async function getIntradayBarsWithStatus(
  ticker: string,
  multiplier: number,
  timespan: 'minute' | 'hour',
  from: string,
  to: string,
): Promise<{ bars: Bar[]; unauthorized: boolean }> {
  const url = `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/${multiplier}/${timespan}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${polygonKey()}`;
  const res = await fetch(url);
  if (res.status === 403) {
    // Plan-gated. Read the body defensively for logging parity but the
    // status alone is the signal.
    return { bars: [], unauthorized: true };
  }
  if (!res.ok) throw new Error(`Polygon intraday bars ${ticker}: ${res.status}`);
  const body = await res.json();
  if (body?.status === 'NOT_AUTHORIZED') {
    return { bars: [], unauthorized: true };
  }
  const data = parseOrFallback(
    PolygonAggregatesResponseSchema,
    body,
    { provider: 'polygon', endpoint: 'aggregates-intraday', ticker },
    { results: [] },
  );
  return { bars: (data.results ?? []) as Bar[], unauthorized: false };
}

export async function getPreviousClose(ticker: string): Promise<Bar | null> {
  const url = `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${polygonKey()}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = parseOrFallback(
    PolygonAggregatesResponseSchema,
    await res.json(),
    { provider: 'polygon', endpoint: 'previous-close', ticker },
    { results: [] },
  );
  return ((data.results?.[0] ?? null) as Bar | null);
}

// ---------------------------------------------------------------------------
// Fundamentals
// ---------------------------------------------------------------------------

export interface FundamentalsSnapshot {
  // -----------------------------------------------------------------------
  // SCORING-FACING FIELDS (Phase 4w W2: contract preserved exactly).
  // These are the names + semantics that runFundamental, scan-lynch,
  // scan-prophet, prophet-sieve and earnings-intel already consume.
  // **DO NOT rename or change semantics** — analyst scores must not move
  // because of the vendor migration.
  // -----------------------------------------------------------------------
  ticker: string;
  revenue?: number;
  priorRevenue?: number;
  revenueGrowthYoY?: number;
  eps?: number;
  priorEps?: number;
  epsGrowthYoY?: number;
  ttmEps?: number;
  /** TTM EPS as of ~1 year ago (sum of quarters 3-6). Used by 4c-2 for
   *  the multiple-expansion signal so current P/E (price/ttmEps) is
   *  compared to a year-ago P/E on the same TTM basis, not against a
   *  single quarter's EPS. */
  priorTtmEps?: number;
  /** TTM-vs-prior-TTM EPS growth ((ttmEps − priorTtmEps) / |priorTtmEps|).
   *  Wave 4C (review M5): the Lynch PEG input. Unlike `epsGrowthYoY`
   *  (latest quarter vs year-ago quarter), this smooths single-quarter
   *  base effects — a +300% rebound off one depressed comp no longer
   *  reads as 300% "growth". Undefined unless all 8 quarters are present. */
  epsGrowthTTM?: number;
  grossMargin?: number;
  /** Gross margin from prior quarter (Q/Q baseline). */
  priorGrossMargin?: number;
  /** Gross margin from 4 quarters ago (YoY baseline; 4c-2 multiple-expansion + margin-trend). */
  priorGrossMarginYoY?: number;
  operatingMargin?: number;
  /** Operating margin from prior quarter (Q/Q baseline). */
  priorOperatingMargin?: number;
  /** Operating margin from 4 quarters ago (YoY baseline; 4c-2). */
  priorOperatingMarginYoY?: number;
  debtToEquity?: number;
  asOf?: string;

  // -----------------------------------------------------------------------
  // COMPREHENSIVE BLOCK (Phase 4w W2: ADDITIVE).
  // Source: Massive ratios (live mode) + the three statement endpoints.
  // Null fields carry a reason in the per-group `_reasons` map — no silent
  // omission. The Phase 6 detail panel (PR-A+) and PR-B's FundamentalsStrip
  // are the primary consumers.
  // -----------------------------------------------------------------------
  valuation?: ValuationGroup;
  profitability?: ProfitabilityGroup;
  liquidity?: LiquidityGroup;
  leverage?: LeverageGroup;
  cashflow?: CashflowGroup;
  growth?: GrowthGroup;
  /** Quarterly statement bundle for the fundamentals charts (5y+ history). */
  statements?: QuarterlyStatement[];
  meta?: FundamentalsMeta;
}

export interface ValuationGroup {
  pe: number | null;
  pb: number | null;
  ps: number | null;
  pcf: number | null;
  pfcf: number | null;
  evToEbitda: number | null;
  evToSales: number | null;
  enterpriseValue: number | null;
  marketCap: number | null;
  _reasons?: Record<string, string>;
}

export interface ProfitabilityGroup {
  roe: number | null;
  roa: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  netMargin: number | null;
  eps: number | null;
  _reasons?: Record<string, string>;
}

export interface LiquidityGroup {
  currentRatio: number | null;
  quickRatio: number | null;
  cashRatio: number | null;
  _reasons?: Record<string, string>;
}

export interface LeverageGroup {
  debtToEquity: number | null;
  longTermDebt: number | null;
  _reasons?: Record<string, string>;
}

export interface CashflowGroup {
  freeCashFlow: number | null;
  dividendYield: number | null;
  _reasons?: Record<string, string>;
}

export interface GrowthGroup {
  revenueGrowthYoY: number | null;
  epsGrowthYoY: number | null;
  _reasons?: Record<string, string>;
}

export interface QuarterlyStatement {
  periodEnd: string;
  filingDate: string | null;
  fiscalQuarter: number | null;
  fiscalYear: number | null;
  income: {
    revenue: number | null;
    grossProfit: number | null;
    operatingIncome: number | null;
    netIncome: number | null;
    basicEps: number | null;
    ebitda: number | null;
  };
  balance: {
    totalAssets: number | null;
    totalCurrentAssets: number | null;
    totalCurrentLiabilities: number | null;
    cashAndEquivalents: number | null;
    inventories: number | null;
    longTermDebt: number | null;
    debtCurrent: number | null;
    totalEquity: number | null;
  };
  cashflow: {
    operatingCashFlow: number | null;
    capitalExpenditure: number | null;
    freeCashFlow: number | null;
    dividendsPaid: number | null;
  };
}

export interface FundamentalsMeta {
  asOf: string | null;
  latestFilingDate: string | null;
  /** Provider tag — `'massive-ratios+statements'` (live) or
   *  `'massive-statements-pit'` (PIT-derived). */
  source: 'massive-ratios+statements' | 'massive-statements-pit' | 'no-data';
  /** Why specific groups/values are null, when not already captured at the
   *  per-group level. */
  _reasons?: Record<string, string>;
}

/**
 * Estimate a filing date when the provider returns `filing_date: null`
 * (common for older annuals). SEC's 10-K deadline is 60-90 days post-period;
 * 10-Qs are 40-45 days. The defensive fallback keeps the in-memory PIT
 * filter from silently excluding annuals that were public on `asOfDate`.
 * Worst-case error is ±15 days, documented in docs/POINT_IN_TIME_AUDIT.md.
 */
function estimateFilingDate(periodEnd: string | undefined, fiscalQuarter: number | undefined): string | undefined {
  if (!periodEnd) return undefined;
  const lagDays = fiscalQuarter === 4 || fiscalQuarter === undefined ? 75 : 40;
  const t = Date.parse(periodEnd);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + lagDays * 86400000).toISOString().slice(0, 10);
}

/** Coerce a nullable Massive field to a finite number, or undefined. */
function n(v: number | null | undefined): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Same, but returning `number | null` for the comprehensive block. */
function nn(v: number | null | undefined): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function fiscalQuarter(row: MassiveIncomeStatement | MassiveBalanceSheet | MassiveCashFlow | undefined): number | undefined {
  if (!row) return undefined;
  const fq = row.fiscal_quarter;
  if (typeof fq === 'number') return fq;
  if (typeof fq === 'string') {
    const parsed = Number(fq.replace(/[^0-9]/g, ''));
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function fiscalYear(row: MassiveIncomeStatement | MassiveBalanceSheet | MassiveCashFlow | undefined): number | null {
  if (!row) return null;
  const fy = row.fiscal_year;
  if (typeof fy === 'number') return fy;
  if (typeof fy === 'string') {
    const parsed = Number(fy);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * Filter a newest-first statement list by `(filing_date ?? estimateFilingDate)
 * <= asOfDate`. Defense-in-depth on top of the API-side `filing_date.lte`
 * filter; matches the legacy VX-era discipline.
 */
function filterByFilingDate<T extends { period_end?: string; filing_date?: string | null; fiscal_quarter?: number | string }>(
  rows: T[],
  asOfDate: string,
): T[] {
  return rows.filter((r) => {
    const fd = r.filing_date ?? estimateFilingDate(r.period_end, fiscalQuarter(r as { fiscal_quarter?: number | string }));
    return fd !== undefined && fd <= asOfDate;
  });
}

// ---------------------------------------------------------------------------
// 24h live cache for assembled FundamentalsSnapshots (no asOfDate).
// PIT mode (asOfDate set) routes through pit-cache via the per-endpoint
// fetchers in massive-fundamentals.ts.
// ---------------------------------------------------------------------------

const LIVE_CACHE = makeLiveCache<FundamentalsSnapshot>();

/** Test seam — clears the 24h live cache. */
export function _clearLiveFundamentalsCache(): void {
  LIVE_CACHE.clear();
}

/**
 * Fetch a fundamentals snapshot for `ticker`. Returns the existing
 * scoring-facing fields PLUS a comprehensive `valuation/profitability/
 * liquidity/leverage/cashflow/growth/statements/meta` block (Phase 4w W2).
 *
 * Data sources (Phase 4w migration):
 *   - **LIVE mode (no asOfDate)**: Massive ratios + income/balance/cashflow
 *     statements. Ratios endpoint supplies the vendor-canonical valuation
 *     and liquidity numbers (pe, pb, ps, roe, roa, current/quick/cash);
 *     statements supply revenue/EPS/margins/growth and the quarterly bundle.
 *     Assembled snapshot cached in-process for 24h per ticker.
 *
 *   - **PIT mode (asOfDate set)**: ratios is skipped (it's a vendor-side
 *     current-snapshot endpoint with no historical mode). The comprehensive
 *     block is derived from the PIT-filtered statement set; valuation
 *     ratios that need a historical price are returned `null` with a
 *     `_reasons.needs_historical_price` flag, profitability/liquidity/
 *     leverage/cashflow are computed from the statement line items.
 *
 * PIT discipline (W1c lesson — no cache poisoning):
 *   - Per-endpoint pit-cache entries via `pitCacheGet`/`pitCacheSet`.
 *   - Rate-limit-exhausted / hard-error fetches THROW; the outer
 *     `.catch(() => null)` in callers turns the throw into null AND the
 *     cache write is skipped (no error-null poisoning).
 *   - Legitimately-empty PIT windows (e.g. pre-IPO date) ARE cached —
 *     empty IS PIT-stable.
 *
 * The scoring-facing fields preserve their existing names and decimal-
 * fraction semantics (margins as 0.44 = 44%, growth as 0.19 = 19%). The
 * fundamental analyst score is unchanged.
 *
 * See docs/POINT_IN_TIME_AUDIT.md and reports/phase-4w/design.md.
 */
export async function getFundamentals(
  ticker: string,
  opts: { asOfDate?: string } = {},
): Promise<FundamentalsSnapshot | null> {
  // LIVE cache hit
  if (!opts.asOfDate) {
    const hit = LIVE_CACHE.get(ticker);
    if (hit) return hit;
  }

  try {
    let income: MassiveIncomeStatement[];
    let balance: MassiveBalanceSheet[];
    let cashflow: MassiveCashFlow[];
    let ratiosRow: MassiveRatiosResult | null = null;

    if (opts.asOfDate) {
      // PIT mode — three statement endpoints, no ratios endpoint.
      const [inc, bs, cf] = await Promise.all([
        getIncomeStatementsPit(ticker, opts.asOfDate, 8),
        getBalanceSheetsPit(ticker, opts.asOfDate, 8),
        getCashFlowStatementsPit(ticker, opts.asOfDate, 8),
      ]);
      // Defense-in-depth filter — re-apply on top of the API-side filter
      // because rows with null `filing_date` slip past the server-side
      // predicate (same residual the VX path guarded against).
      income = filterByFilingDate(inc, opts.asOfDate);
      balance = filterByFilingDate(bs, opts.asOfDate);
      cashflow = filterByFilingDate(cf, opts.asOfDate);
    } else {
      // LIVE mode — ratios + three statement endpoints in parallel.
      const [ratiosResp, incomeResp, balanceResp, cashflowResp] = await Promise.all([
        fetchRatiosWithStatus(ticker),
        fetchIncomeStatementsWithStatus(ticker, { limit: 8 }),
        fetchBalanceSheetsWithStatus(ticker, { limit: 8 }),
        fetchCashFlowStatementsWithStatus(ticker, { limit: 8 }),
      ]);
      // Live mode: rate-limit-exhausted or hard-error on statements is a
      // failure (return null). Ratios alone failing is tolerable — we
      // derive the comprehensive block from statements instead and flag it.
      if (incomeResp.rateLimitExhausted || incomeResp.errorMessage) throw new Error(incomeResp.errorMessage ?? 'income statements rate-limit');
      if (balanceResp.rateLimitExhausted || balanceResp.errorMessage) throw new Error(balanceResp.errorMessage ?? 'balance sheets rate-limit');
      if (cashflowResp.rateLimitExhausted || cashflowResp.errorMessage) throw new Error(cashflowResp.errorMessage ?? 'cash flow rate-limit');
      income = incomeResp.data;
      balance = balanceResp.data;
      cashflow = cashflowResp.data;
      ratiosRow = ratiosResp.data[0] ?? null;
    }

    if (income.length === 0 && balance.length === 0 && cashflow.length === 0) {
      return null;
    }

    const assembled = assembleSnapshot(ticker, income, balance, cashflow, ratiosRow, !opts.asOfDate);
    if (!opts.asOfDate && assembled) LIVE_CACHE.set(ticker, assembled);
    return assembled;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Assembler
// ---------------------------------------------------------------------------

function assembleSnapshot(
  ticker: string,
  income: MassiveIncomeStatement[],
  balance: MassiveBalanceSheet[],
  cashflow: MassiveCashFlow[],
  ratios: MassiveRatiosResult | null,
  liveMode: boolean,
): FundamentalsSnapshot | null {
  const latestInc = income[0];
  const priorInc = income[1];
  const yearAgoInc = income[3];
  const latestBal = balance[0];
  const latestCf = cashflow[0];

  if (!latestInc && !latestBal) return null;

  // ----- Scoring-facing fields (Phase 4w contract preservation) ---------
  const revenue = n(latestInc?.revenue);
  const priorRevenue = n(yearAgoInc?.revenue);
  const priorRev = n(priorInc?.revenue);
  const eps = n(latestInc?.basic_earnings_per_share);
  const priorEpsYoY = n(yearAgoInc?.basic_earnings_per_share);
  const grossProfit = n(latestInc?.gross_profit);
  const priorGrossProfit = n(priorInc?.gross_profit);
  const yearAgoGrossProfit = n(yearAgoInc?.gross_profit);
  // Q4 decision: VX `operating_income_loss` → Massive `operating_income`
  // (sign-equivalent; the suffix drop is cosmetic).
  const opIncome = n(latestInc?.operating_income);
  const priorOpIncome = n(priorInc?.operating_income);
  const yearAgoOpIncome = n(yearAgoInc?.operating_income);
  // Q3/Q4 decisions: long-term debt = `_and_capital_lease_obligations`,
  // equity = `total_equity_attributable_to_parent`.
  const longTermDebt = n(latestBal?.long_term_debt_and_capital_lease_obligations);
  const totalEquity = n(latestBal?.total_equity_attributable_to_parent)
    ?? n(latestBal?.total_equity); // safety fallback when attributable-to-parent missing

  // ttmEps and priorTtmEps preserve VX semantics, with one Wave 4C
  // correction (review M5 prerequisite): ttmEps previously mapped missing
  // quarters to 0 while priorTtmEps tracked an ok flag — a name with only
  // 2 reported quarters got a half-year "TTM" EPS. Both windows now use
  // the same ok-flag discipline: undefined unless every quarter in the
  // window reported basic EPS.
  const sumEpsWindow = (rows: MassiveIncomeStatement[], expected: number) =>
    rows.length >= expected
      ? rows.reduce<{ sum: number; ok: boolean }>(
          (acc, r) => {
            const v = n(r.basic_earnings_per_share);
            return v !== undefined ? { sum: acc.sum + v, ok: acc.ok } : { sum: acc.sum, ok: false };
          },
          { sum: 0, ok: true },
        )
      : { sum: 0, ok: false };
  const ttmEpsAcc = sumEpsWindow(income.slice(0, 4), 4);
  const priorTtmEpsAcc = sumEpsWindow(income.slice(3, 7), 4); // < 7 quarters ⇒ short window ⇒ not ok
  const ttmEpsVal = ttmEpsAcc.ok ? ttmEpsAcc.sum : undefined;
  const priorTtmEpsVal = priorTtmEpsAcc.ok && priorTtmEpsAcc.sum !== 0 ? priorTtmEpsAcc.sum : undefined;
  // Wave 4C (review M5): TTM-on-TTM growth for the Lynch PEG input.
  const epsGrowthTTM =
    ttmEpsVal !== undefined && priorTtmEpsVal !== undefined
      ? (ttmEpsVal - priorTtmEpsVal) / Math.abs(priorTtmEpsVal)
      : undefined;

  const revenueGrowthYoY =
    revenue !== undefined && priorRevenue !== undefined && priorRevenue !== 0
      ? (revenue - priorRevenue) / priorRevenue
      : undefined;
  const epsGrowthYoY =
    eps !== undefined && priorEpsYoY !== undefined && priorEpsYoY !== 0
      ? (eps - priorEpsYoY) / Math.abs(priorEpsYoY)
      : undefined;
  const grossMargin = revenue && grossProfit !== undefined ? grossProfit / revenue : undefined;
  const priorGrossMargin = priorRev && priorGrossProfit !== undefined ? priorGrossProfit / priorRev : undefined;
  const priorGrossMarginYoY = priorRevenue && yearAgoGrossProfit !== undefined ? yearAgoGrossProfit / priorRevenue : undefined;
  const operatingMargin = revenue && opIncome !== undefined ? opIncome / revenue : undefined;
  const priorOperatingMargin = priorRev && priorOpIncome !== undefined ? priorOpIncome / priorRev : undefined;
  const priorOperatingMarginYoY = priorRevenue && yearAgoOpIncome !== undefined ? yearAgoOpIncome / priorRevenue : undefined;
  const debtToEquity =
    longTermDebt !== undefined && totalEquity !== undefined && totalEquity !== 0
      ? longTermDebt / totalEquity
      : undefined;

  // ----- Comprehensive groups (additive) --------------------------------
  const netIncome = n(latestInc?.consolidated_net_income_loss)
    ?? n(latestInc?.net_income_loss_attributable_common_shareholders);
  const netMargin = revenue && netIncome !== undefined ? netIncome / revenue : undefined;
  const totalAssets = n(latestBal?.total_assets);
  const totalCurAssets = n(latestBal?.total_current_assets);
  const totalCurLiab = n(latestBal?.total_current_liabilities);
  const inventories = n(latestBal?.inventories);
  const cashAndEquivalents = n(latestBal?.cash_and_equivalents);
  const debtCurrent = n(latestBal?.debt_current);
  const ocf = n(latestCf?.net_cash_from_operating_activities);
  const capex = n(latestCf?.purchase_of_property_plant_and_equipment);

  // FCF: OCF + capex (capex is negative in cashflow statement convention,
  // so addition yields OCF − |capex|).
  const freeCashFlow = ocf !== undefined && capex !== undefined ? ocf + capex : (ocf !== undefined ? ocf : undefined);

  const valuation: ValuationGroup = liveMode && ratios
    ? {
        pe: nn(ratios.price_to_earnings),
        pb: nn(ratios.price_to_book),
        ps: nn(ratios.price_to_sales),
        pcf: nn(ratios.price_to_cash_flow),
        pfcf: nn(ratios.price_to_free_cash_flow),
        evToEbitda: nn(ratios.ev_to_ebitda),
        evToSales: nn(ratios.ev_to_sales),
        enterpriseValue: nn(ratios.enterprise_value),
        marketCap: nn(ratios.market_cap),
      }
    : {
        pe: null, pb: null, ps: null, pcf: null, pfcf: null,
        evToEbitda: null, evToSales: null, enterpriseValue: null, marketCap: null,
        _reasons: {
          pe: 'requires_historical_price',
          pb: 'requires_historical_price',
          ps: 'requires_historical_price',
          pcf: 'requires_historical_price',
          pfcf: 'requires_historical_price',
          evToEbitda: 'requires_historical_price',
          evToSales: 'requires_historical_price',
          enterpriseValue: 'requires_historical_price',
          marketCap: 'requires_historical_price',
        },
      };

  const profitability: ProfitabilityGroup = {
    roe: nn(ratios?.return_on_equity) ?? (netIncome !== undefined && totalEquity ? round(netIncome / totalEquity, 6) : null),
    roa: nn(ratios?.return_on_assets) ?? (netIncome !== undefined && totalAssets ? round(netIncome / totalAssets, 6) : null),
    grossMargin: nn(grossMargin),
    operatingMargin: nn(operatingMargin),
    netMargin: nn(netMargin),
    eps: nn(eps),
  };

  const liquidity: LiquidityGroup = {
    currentRatio: nn(ratios?.current) ?? (totalCurAssets !== undefined && totalCurLiab ? round(totalCurAssets / totalCurLiab, 4) : null),
    quickRatio: nn(ratios?.quick) ?? (totalCurAssets !== undefined && inventories !== undefined && totalCurLiab ? round((totalCurAssets - inventories) / totalCurLiab, 4) : null),
    cashRatio: nn(ratios?.cash) ?? (cashAndEquivalents !== undefined && totalCurLiab ? round(cashAndEquivalents / totalCurLiab, 4) : null),
  };

  const leverage: LeverageGroup = {
    debtToEquity: nn(ratios?.debt_to_equity) ?? nn(debtToEquity),
    longTermDebt: nn(longTermDebt),
  };

  const dividends = n(latestCf?.dividends);
  const cashflowGroup: CashflowGroup = {
    freeCashFlow: nn(ratios?.free_cash_flow) ?? nn(freeCashFlow),
    dividendYield: nn(ratios?.dividend_yield),
    ...(liveMode || ratios?.dividend_yield !== undefined
      ? {}
      : { _reasons: { dividendYield: 'requires_historical_price' } }),
  };
  if (cashflowGroup.dividendYield === null && !liveMode) {
    cashflowGroup._reasons = { ...(cashflowGroup._reasons ?? {}), dividendYield: 'requires_historical_price' };
  }
  // dividendsPaid line item is preserved in the per-quarter `statements`
  // bundle below; the surface above uses dividend YIELD which is a
  // price-dependent ratio (null in PIT mode).
  if (dividends === undefined) { /* dividend payments absent — keep narrative in statements only */ }

  const growth: GrowthGroup = {
    revenueGrowthYoY: nn(revenueGrowthYoY),
    epsGrowthYoY: nn(epsGrowthYoY),
  };

  const statements = buildStatementBundle(income, balance, cashflow);

  const meta: FundamentalsMeta = {
    asOf: latestInc?.period_end ?? latestBal?.period_end ?? null,
    latestFilingDate: latestInc?.filing_date ?? latestBal?.filing_date ?? null,
    source: liveMode ? 'massive-ratios+statements' : 'massive-statements-pit',
  };
  if (liveMode && !ratios) {
    meta._reasons = { ratios: 'ratios_endpoint_unavailable' };
  }

  return {
    // Scoring-facing fields — exact preservation.
    ticker,
    revenue,
    priorRevenue,
    revenueGrowthYoY,
    eps,
    priorEps: priorEpsYoY,
    epsGrowthYoY,
    ttmEps: ttmEpsVal,
    priorTtmEps: priorTtmEpsVal,
    epsGrowthTTM,
    grossMargin,
    priorGrossMargin,
    priorGrossMarginYoY,
    operatingMargin,
    priorOperatingMargin,
    priorOperatingMarginYoY,
    debtToEquity,
    asOf: latestInc?.period_end ?? latestBal?.period_end,
    // Comprehensive (Phase 4w W2).
    valuation,
    profitability,
    liquidity,
    leverage,
    cashflow: cashflowGroup,
    growth,
    statements,
    meta,
  };
}

function buildStatementBundle(
  income: MassiveIncomeStatement[],
  balance: MassiveBalanceSheet[],
  cashflow: MassiveCashFlow[],
): QuarterlyStatement[] {
  // Index balance + cashflow by period_end for join with income (the
  // statements come back from independent endpoints; matching by period_end
  // is the natural alignment).
  const bByPeriod = new Map<string, MassiveBalanceSheet>();
  for (const b of balance) if (b.period_end) bByPeriod.set(b.period_end, b);
  const cByPeriod = new Map<string, MassiveCashFlow>();
  for (const c of cashflow) if (c.period_end) cByPeriod.set(c.period_end, c);

  return income
    .filter((r) => r.period_end)
    .map((inc) => {
      const pe = inc.period_end!;
      const bal = bByPeriod.get(pe);
      const cf = cByPeriod.get(pe);
      const ocf = n(cf?.net_cash_from_operating_activities);
      const capex = n(cf?.purchase_of_property_plant_and_equipment);
      const fcf = ocf !== undefined && capex !== undefined ? ocf + capex : (ocf ?? null);
      return {
        periodEnd: pe,
        filingDate: inc.filing_date ?? bal?.filing_date ?? cf?.filing_date ?? null,
        fiscalQuarter: fiscalQuarter(inc) ?? null,
        fiscalYear: fiscalYear(inc),
        income: {
          revenue: nn(inc.revenue),
          grossProfit: nn(inc.gross_profit),
          operatingIncome: nn(inc.operating_income),
          netIncome: nn(inc.consolidated_net_income_loss) ?? nn(inc.net_income_loss_attributable_common_shareholders),
          basicEps: nn(inc.basic_earnings_per_share),
          ebitda: nn(inc.ebitda),
        },
        balance: {
          totalAssets: nn(bal?.total_assets),
          totalCurrentAssets: nn(bal?.total_current_assets),
          totalCurrentLiabilities: nn(bal?.total_current_liabilities),
          cashAndEquivalents: nn(bal?.cash_and_equivalents),
          inventories: nn(bal?.inventories),
          longTermDebt: nn(bal?.long_term_debt_and_capital_lease_obligations),
          debtCurrent: nn(bal?.debt_current),
          totalEquity: nn(bal?.total_equity_attributable_to_parent) ?? nn(bal?.total_equity),
        },
        cashflow: {
          operatingCashFlow: nn(cf?.net_cash_from_operating_activities),
          capitalExpenditure: nn(cf?.purchase_of_property_plant_and_equipment),
          freeCashFlow: typeof fcf === 'number' ? round(fcf, 0) : null,
          dividendsPaid: nn(cf?.dividends),
        },
      };
    });
}

function round(x: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(x * f) / f;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export interface NewsItem {
  id: string;
  title: string;
  description?: string;
  publishedUtc: string;
  url: string;
  tickers: string[];
  publisher?: string;
}

/**
 * Fetch news articles for `ticker`. Default returns the most recent
 * `limit` articles.
 *
 * PIT semantics: when `asOfDate` is supplied, only articles published on
 * or before `asOfDate` (end-of-day UTC) are returned. We use Polygon's
 * native `published_utc.lte` server-side filter — never client-side
 * filtering, because Polygon's news index spans many GB and pulling it
 * all client-side would be slow and rate-limit-heavy.
 *
 * Polygon at audit time treats `published_utc.lte=YYYY-MM-DD` as
 * end-of-day inclusive (verified — articles from 2024-01-01T13:30:00Z
 * came through under `lte=2024-01-01`), but we still pass the explicit
 * `T23:59:59Z` form to make intent unambiguous.
 *
 * PIT-cacheable: keyed by (ticker, asOfDate, limit).
 */
export async function getNews(
  ticker: string,
  optsOrLimit: { asOfDate?: string; limit?: number } | number = 20,
): Promise<NewsItem[]> {
  // Backwards-compatible: callers passing a bare `limit` number still work.
  const opts = typeof optsOrLimit === 'number' ? { limit: optsOrLimit } : optsOrLimit;
  const limit = opts.limit ?? 20;
  try {
    const cutoffParam = opts.asOfDate
      ? `&published_utc.lte=${encodeURIComponent(`${opts.asOfDate}T23:59:59Z`)}`
      : '';
    const url = `${POLYGON}/v2/reference/news?ticker=${ticker}&limit=${limit}&order=desc&sort=published_utc${cutoffParam}&apiKey=${polygonKey()}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = parseOrFallback(
      PolygonNewsResponseSchema,
      await res.json(),
      { provider: 'polygon', endpoint: opts.asOfDate ? `news:asOf=${opts.asOfDate}` : 'news', ticker },
      { results: [] },
    );
    return (data.results ?? []).map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      publishedUtc: r.published_utc,
      url: r.article_url,
      tickers: r.tickers ?? [],
      publisher: r.publisher?.name,
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Finnhub earnings
// ---------------------------------------------------------------------------

export interface UpcomingEarning {
  ticker: string;
  date: string;
  hour?: string;
  epsEstimate?: number;
  revenueEstimate?: number;
}

/**
 * PIT-cacheable: keyed by (ticker, daysAhead, asOfDate).
 *
 * When asOfDate is supplied, the calendar window is computed relative
 * to it instead of "now" — the backtest knows that, on a past date,
 * the next-known earnings would only be the ones whose announcement
 * date is ≥ asOfDate.
 */
export async function getUpcomingEarnings(
  ticker: string,
  daysAhead = 60,
  opts: { asOfDate?: string } = {},
): Promise<UpcomingEarning | null> {
  try {
    const asOf = opts.asOfDate ?? new Date().toISOString().slice(0, 10);
    const asOfMs = new Date(`${asOf}T12:00:00Z`).getTime();
    const from = asOf;
    const to = new Date(asOfMs + daysAhead * 86400000).toISOString().slice(0, 10);
    const url = `${FINNHUB}/calendar/earnings?from=${from}&to=${to}&symbol=${ticker}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = parseOrFallback(
      FinnhubEarningsCalendarResponseSchema,
      await res.json(),
      { provider: 'finnhub', endpoint: 'calendar/earnings', ticker },
      { earningsCalendar: [] },
    );
    // Post-filter for safety — Finnhub sometimes returns dates outside window.
    const inWindow = (data.earningsCalendar ?? []).filter(
      (e) => e.date >= from && e.date <= to,
    );
    const first = inWindow[0];
    if (!first) return null;
    return {
      ticker,
      date: first.date,
      hour: first.hour,
      epsEstimate: first.epsEstimate ?? undefined,
      revenueEstimate: first.revenueEstimate ?? undefined,
    };
  } catch {
    return null;
  }
}

export interface EarningsCalendarRangeStatus {
  /** Parsed calendar entries (empty when the call failed OR was genuinely empty). */
  entries: UpcomingEarning[];
  /** True iff the HTTP call returned 2xx and parsed. */
  ok: boolean;
  /** HTTP status of the final attempt (0 for network/thrown errors). */
  httpStatus: number;
  /** True if every 429-retry was exhausted. */
  rateLimitExhausted: boolean;
  /** Non-HTTP failure message, when thrown. */
  errorMessage?: string;
}

/**
 * FIX-1 W1 — status-aware variant of getEarningsCalendarRange.
 *
 * The earnings scan's production failure mode (diagnosed 2026-07-08 from
 * the snapshot history) was this call silently returning `[]` on a
 * non-OK response: the scan then "completed" in ~200ms with
 * universeChecked=0 and PUBLISHED the hollow snapshot over a good
 * `_latest`. This variant (a) paces through the shared Finnhub token
 * bucket, (b) retries 429s via fetchWithRateLimit, and (c) surfaces the
 * outcome so the checkpoint-resume worker can refuse to publish when
 * calendar resolution failed.
 */
export async function getEarningsCalendarRangeWithStatus(
  daysAhead = 14,
  daysBack = 0,
): Promise<EarningsCalendarRangeStatus> {
  try {
    await getFinnhubBucket().acquire();
    const from = new Date(Date.now() - Math.max(0, daysBack) * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
    const url = `${FINNHUB}/calendar/earnings?from=${from}&to=${to}&token=${finnhubKey()}`;
    const { res, rateLimitExhausted } = await fetchWithRateLimit(url, undefined);
    if (!res.ok) {
      if (res.status === 429) {
        console.warn('[earnings-cal] Finnhub 429 exhausted on calendar range; caller must not publish');
      } else {
        console.warn(`[earnings-cal] Finnhub calendar range HTTP ${res.status}; caller must not publish`);
      }
      return { entries: [], ok: false, httpStatus: res.status, rateLimitExhausted };
    }
    const data = parseOrFallback(
      FinnhubEarningsCalendarResponseSchema,
      await res.json(),
      { provider: 'finnhub', endpoint: 'calendar/earnings/range' },
      { earningsCalendar: [] },
    );
    const entries = (data.earningsCalendar ?? []).map((e) => ({
      ticker: e.symbol,
      date: e.date,
      hour: e.hour,
      epsEstimate: e.epsEstimate ?? undefined,
      revenueEstimate: e.revenueEstimate ?? undefined,
    }));
    return { entries, ok: true, httpStatus: res.status, rateLimitExhausted: false };
  } catch (err: any) {
    return {
      entries: [],
      ok: false,
      httpStatus: 0,
      rateLimitExhausted: false,
      errorMessage: String(err?.message ?? err),
    };
  }
}

export async function getEarningsCalendarRange(
  daysAhead = 14,
  daysBack = 0,
): Promise<UpcomingEarning[]> {
  const r = await getEarningsCalendarRangeWithStatus(daysAhead, daysBack);
  return r.entries;
}

export interface EarningsSurprise {
  /**
   * Fiscal quarter END (Finnhub `period`, e.g. 2025-03-31) — when the
   * quarter closed, NOT when the market learned the numbers. Never window
   * price reactions or PIT-filter visibility on this field (CR-3): the
   * announcement lags it by 2-8 weeks.
   */
  period: string;
  /**
   * Announcement date — when the report actually hit the tape, joined
   * from Finnhub's earnings calendar (whose `date` IS the announcement
   * date) by fiscal (year, quarter) with a period-window fallback.
   * `null` when the calendar had no matching row OR the caller didn't
   * request the join. Consumers MUST skip announcement-anchored math
   * (reaction windows, drift, PIT visibility) for null rows — silently
   * falling back to `period` is the exact bug this field replaces.
   */
  announceDate: string | null;
  epsActual: number;
  epsEstimate: number;
  surprisePct?: number;
}

/**
 * Max plausible lag between fiscal period end and the announcement.
 * Typical lag is 2-8 weeks; annual reports for non-accelerated filers can
 * stretch to ~90 days. Calendar rows outside (period, period+120d] are
 * never treated as the announcement for that period.
 */
const MAX_ANNOUNCE_LAG_DAYS = 120;

/**
 * One Finnhub earnings-calendar call covering every surprise period, used
 * to join announcement dates onto /stock/earnings rows. Paced through the
 * shared token bucket + 429-aware retry because it adds one Finnhub call
 * per getEarningsHistory invocation that requests the join.
 */
async function fetchAnnouncementCalendar(
  ticker: string,
  periods: string[],
): Promise<Array<{ date: string; year?: number; quarter?: number }>> {
  const sorted = [...periods].sort();
  const from = sorted[0];
  const toMs =
    Date.parse(`${sorted[sorted.length - 1]}T00:00:00Z`) +
    MAX_ANNOUNCE_LAG_DAYS * 86400000;
  const to = new Date(toMs).toISOString().slice(0, 10);
  await getFinnhubBucket().acquire();
  const url = `${FINNHUB}/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${finnhubKey()}`;
  const { res } = await fetchWithRateLimit(url, undefined);
  if (!res.ok) {
    if (res.status === 429) {
      console.warn(`[earnings-history] Finnhub 429 exhausted on calendar join for ${ticker}; announceDates stay null`);
    }
    return [];
  }
  const data = parseOrFallback(
    FinnhubEarningsCalendarResponseSchema,
    await res.json(),
    { provider: 'finnhub', endpoint: 'calendar/earnings/announce-join', ticker },
    { earningsCalendar: [] },
  );
  return (data.earningsCalendar ?? [])
    .filter((c) => typeof c.date === 'string' && c.date.length >= 10)
    .map((c) => ({ date: c.date, year: c.year, quarter: c.quarter }));
}

/** True when `calDate` is a plausible announcement for `period`. */
function isPlausibleAnnouncement(period: string, calDate: string): boolean {
  if (calDate <= period) return false;
  const lagMs = Date.parse(`${calDate}T00:00:00Z`) - Date.parse(`${period}T00:00:00Z`);
  return lagMs <= MAX_ANNOUNCE_LAG_DAYS * 86400000;
}

/**
 * Mutates `rows`, setting `announceDate` from the calendar. Join order:
 *   1. fiscal (year, quarter) match — authoritative when both feeds carry
 *      the labels, still constrained to the plausible window;
 *   2. earliest calendar date in (period, period+120d].
 * If two periods resolve to the SAME calendar date (a quarter's calendar
 * row is missing, so an older period grabs the next quarter's print),
 * only the latest period keeps it — the rest stay null. Conservative by
 * design: a wrong-but-plausible date is worse than an explicit null.
 */
function assignAnnounceDates(
  rows: Array<{ period: string; yq: string | null; announceDate: string | null }>,
  calendar: Array<{ date: string; year?: number; quarter?: number }>,
): void {
  const calSorted = [...calendar].sort((a, b) => a.date.localeCompare(b.date));
  const byYq = new Map<string, string>();
  for (const c of calSorted) {
    if (c.year !== undefined && c.quarter !== undefined) {
      const k = `${c.year}q${c.quarter}`;
      if (!byYq.has(k)) byYq.set(k, c.date);
    }
  }
  const claims = new Map<string, Array<(typeof rows)[number]>>();
  for (const row of rows) {
    let match: string | undefined;
    if (row.yq !== null) {
      const d = byYq.get(row.yq);
      if (d !== undefined && isPlausibleAnnouncement(row.period, d)) match = d;
    }
    if (match === undefined) {
      match = calSorted.find((c) => isPlausibleAnnouncement(row.period, c.date))?.date;
    }
    if (match !== undefined) {
      const list = claims.get(match) ?? [];
      list.push(row);
      claims.set(match, list);
    }
  }
  for (const [date, claimants] of claims) {
    const winner = claimants.reduce((a, b) => (a.period >= b.period ? a : b));
    winner.announceDate = date;
  }
}

/**
 * PIT-cacheable: keyed by (ticker, limit, asOfDate).
 *
 * LIVE-cacheable (2026-07-15): keyed by (ticker, limit, join-flag) with a
 * 26h TTL for non-empty histories (quarterly data — a day of staleness is
 * immaterial to the trend/quality layers) and 6h for legitimately-empty
 * ones (an ETF stays empty, but empty is also what a plan gap looks like,
 * so re-verify often). Entries expire on their own per-ticker clocks, so
 * the daily refresh rolls gradually across scan slots instead of hitting
 * one run with a full-universe cold sweep.
 *
 * Date semantics (CR-3 fix): each row carries BOTH the fiscal `period`
 * end and the true `announceDate` (joined from the earnings calendar —
 * see EarningsSurprise). The join runs when `withAnnounceDates` is set or
 * whenever `asOfDate` is supplied, and costs one extra Finnhub
 * calendar/earnings call per invocation.
 *
 * When asOfDate is supplied, visibility filters on the ANNOUNCEMENT date:
 * a backtest at past date T must not see reports announced after T, even
 * when their fiscal period ended before T. Rows whose announcement date
 * could not be resolved are EXCLUDED — period-end is never a visibility
 * proxy.
 */
const EARNINGS_HISTORY_LIVE_TTL_MS = 26 * 60 * 60_000;
const EARNINGS_HISTORY_LIVE_EMPTY_TTL_MS = 6 * 60 * 60_000;
const earningsHistoryTtlMs = (rows: EarningsSurprise[]): number =>
  rows.length > 0 ? EARNINGS_HISTORY_LIVE_TTL_MS : EARNINGS_HISTORY_LIVE_EMPTY_TTL_MS;

export async function getEarningsHistory(
  ticker: string,
  limit = 8,
  opts: { asOfDate?: string; withAnnounceDates?: boolean } = {},
): Promise<EarningsSurprise[]> {
  // 2026-07-15 stale-board fix — LIVE calls are served from a Firestore
  // TTL cache so each (ticker, limit, join) variant costs ONE paced
  // Finnhub call per TTL window instead of one per scan run. The #105
  // bucket pacing below is correct but repriced every large-universe scan
  // that calls this per ticker (prophet stage-2: 487 survivors ≈ 9 min of
  // tokens vs a 244s stage budget → chronic partial → `_latest` frozen;
  // lynch/sp500: +9 min blew the 15-min container). Earnings history
  // changes quarterly — refetching it every 30-min slot was the disease.
  // PIT calls (asOfDate set) bypass this entirely and keep their existing
  // pit-cache semantics at the call sites.
  const liveKey: LiveCacheKey | null = opts.asOfDate
    ? null
    : {
        provider: 'finnhub',
        endpoint: 'stock/earnings',
        ticker,
        extra: `limit=${limit}:join=${opts.withAnnounceDates ? 1 : 0}`,
      };
  if (liveKey) {
    const hit = await liveCacheGet<EarningsSurprise[]>(liveKey, earningsHistoryTtlMs);
    if (Array.isArray(hit)) return hit;
  }

  try {
    // Fetch extra to absorb post-filter losses when asOfDate is set.
    const fetchLimit = opts.asOfDate ? Math.max(limit * 4, 32) : limit;
    const url = `${FINNHUB}/stock/earnings?symbol=${ticker}&limit=${fetchLimit}&token=${finnhubKey()}`;
    // Pace through the shared Finnhub token bucket + 429-aware retry. Without
    // this the call was an unpaced raw fetch: a multi-hundred-ticker study
    // burst-hammered Finnhub, exhausted the rate limit, and every earnings
    // call came back 429 → [] → a 0-event study (diagnosed live). The
    // calendar joins already pace this way; align stock/earnings with them.
    await getFinnhubBucket().acquire();
    const { res } = await fetchWithRateLimit(url, undefined);
    if (!res.ok) return [];
    const data = parseOrFallback(
      FinnhubEarningsHistoryResponseSchema,
      await res.json(),
      { provider: 'finnhub', endpoint: 'stock/earnings', ticker },
      [],
    );
    if (!Array.isArray(data)) return [];
    const internal = data
      .map((r) => ({
        period: r.period,
        announceDate: null as string | null,
        yq: r.year !== undefined && r.quarter !== undefined ? `${r.year}q${r.quarter}` : null,
        epsActual: Number(r.actual),
        epsEstimate: Number(r.estimate),
        surprisePct: r.surprisePercent !== undefined ? Number(r.surprisePercent) : undefined,
      }))
      .filter((r) => Number.isFinite(r.epsActual) && Number.isFinite(r.epsEstimate));

    // Join announcement dates when the caller needs them. asOfDate forces
    // the join: PIT visibility is meaningless without announcement dates.
    if ((opts.withAnnounceDates || opts.asOfDate) && internal.length > 0) {
      const calendar = await fetchAnnouncementCalendar(ticker, internal.map((r) => r.period)).catch(() => []);
      assignAnnounceDates(internal, calendar);
    }

    let rows: EarningsSurprise[] = internal.map(({ yq: _yq, ...row }) => row);
    if (opts.asOfDate) {
      // CR-3 / track-5 #4: a report is visible only once ANNOUNCED. Rows
      // with an unresolved announcement are conservatively dropped — the
      // backtest must not guess when the report became public.
      rows = rows.filter((r) => r.announceDate !== null && r.announceDate <= opts.asOfDate!);
    }
    const final = rows
      .sort((a, b) => b.period.localeCompare(a.period))
      .slice(0, limit);

    // Cache success-shaped LIVE results only (M8: this line is only
    // reachable when res.ok and the schema parse produced an array — the
    // !ok early-return and the catch below never write). One extra guard:
    // when the caller asked for the announce-date join and the calendar
    // call failed (every announceDate null despite rows), the result is
    // join-degraded — serve it fresh but don't persist it for 26h.
    if (liveKey) {
      const joinDegraded =
        opts.withAnnounceDates && final.length > 0 && final.every((r) => r.announceDate === null);
      if (!joinDegraded) await liveCacheSet(liveKey, final);
    }
    return final;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Massive/Polygon short interest — /stocks/v1/short-interest (all plans).
// Bi-weekly FINRA-derived settlement data; TRIDENT's crowding penalty
// input (design.md §2 i4). Live-cached 7d (data cadence is 2 weeks).
// ---------------------------------------------------------------------------

export interface ShortInterestRow {
  settlementDate: string;
  shortInterest: number;
  daysToCover: number | null;
  avgDailyVolume: number | null;
}

const SHORT_INTEREST_TTL_MS = 7 * 24 * 60 * 60_000;
const SHORT_INTEREST_EMPTY_TTL_MS = 2 * 24 * 60 * 60_000;
const shortInterestTtl = (rows: ShortInterestRow[]): number =>
  rows.length > 0 ? SHORT_INTEREST_TTL_MS : SHORT_INTEREST_EMPTY_TTL_MS;

/** Latest short-interest settlement rows (newest first, max 3). */
export async function getShortInterest(ticker: string): Promise<ShortInterestRow[]> {
  const liveKey: LiveCacheKey = {
    provider: 'massive', endpoint: 'short-interest', ticker, extra: 'v1',
  };
  const hit = await liveCacheGet<ShortInterestRow[]>(liveKey, shortInterestTtl);
  if (Array.isArray(hit)) return hit;
  try {
    const url = `${POLYGON}/stocks/v1/short-interest?ticker=${encodeURIComponent(ticker)}&limit=3&sort=settlement_date.desc&apiKey=${polygonKey()}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data: any = await res.json();
    const rows: ShortInterestRow[] = Array.isArray(data?.results)
      ? data.results
          .map((r: any) => ({
            settlementDate: String(r.settlement_date ?? ''),
            shortInterest: Number(r.short_interest),
            daysToCover: r.days_to_cover != null ? Number(r.days_to_cover) : null,
            avgDailyVolume: r.avg_daily_volume != null ? Number(r.avg_daily_volume) : null,
          }))
          .filter((r: ShortInterestRow) => r.settlementDate && Number.isFinite(r.shortInterest))
      : [];
    await liveCacheSet(liveKey, rows);
    return rows;
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Finnhub insider transactions — Form 4 feed
// Quiver's /live/insiders endpoint is gated behind a higher subscription tier
// (returns 403 "Upgrade your subscription"). Finnhub exposes the same SEC
// Form 4 data on plans we already pay for. Used by insider-board.ts.
// ---------------------------------------------------------------------------

export interface FinnhubInsiderTx {
  name: string;
  share: number;          // share count after transaction
  change: number;         // signed delta (negative = sale, positive = buy)
  filingDate: string;     // YYYY-MM-DD
  transactionDate: string;
  transactionPrice: number;
  transactionCode: string; // P=purchase, S=sale, etc.
  isDerivative: boolean;
  source: string;
  currency: string;
}

/**
 * Phase 4o W1 — status envelope returned by
 * `getFinnhubInsiderTransactionsWithStatus`. The russell2k checkpoint
 * scan uses this so a 429-storm becomes visible (rateLimited count) and
 * the W3 degraded-publish guard can refuse to swap _latest over a run
 * with too many failed calls.
 */
export interface FinnhubInsiderTxStatus {
  /** Parsed transactions (empty when the call had no data OR was rate-limited). */
  data: FinnhubInsiderTx[];
  /** True if the call was rate-limited at any point (including retries that ultimately succeeded). */
  rateLimited: boolean;
  /** True if every retry on this call returned 429 — the data is missing because of rate-limiting, not because the company has no transactions. */
  rateLimitExhausted: boolean;
  /** Non-429 failure (network, schema, etc.). When set, `data` is empty. */
  errorMessage?: string;
}

/**
 * Fetch insider transactions for `ticker`. Default returns trades from
 * the past `daysBack` days.
 *
 * PIT semantics: when `asOfDate` is supplied, only transactions whose
 * SEC Form 4 filing date (`filingDate`) is on or before `asOfDate` are
 * returned. We use `filingDate` rather than `transactionDate` because
 * a trade is only knowable to outsiders once the Form 4 has been filed
 * — the SEC's 2-business-day filing window means there's a small but
 * meaningful gap between `transactionDate` and `filingDate`.
 *
 * Both Finnhub's API-side `to=<asOfDate>` filter and an in-memory
 * `filingDate <= asOfDate` filter are applied for safety.
 *
 * Phase 4o W1: requests pace through the Finnhub token bucket and a
 * 429 triggers backoff-and-retry. A 429-storm no longer becomes a
 * silent `[]` — exhausted-retry calls are still logged loudly and the
 * status-aware sibling `getFinnhubInsiderTransactionsWithStatus`
 * surfaces the rate-limit flag so the scan can mark the run degraded.
 *
 * PIT-cacheable: keyed by (ticker, asOfDate, daysBack).
 */
export async function getFinnhubInsiderTransactions(
  ticker: string,
  daysBack: number = 180,
  opts: { asOfDate?: string } = {},
): Promise<FinnhubInsiderTx[]> {
  const r = await getFinnhubInsiderTransactionsWithStatus(ticker, daysBack, opts);
  return r.data;
}

/**
 * Phase 4o W1 — status-aware variant of getFinnhubInsiderTransactions.
 * The russell2k insider scan batch calls this so a 429-storm becomes a
 * visible rate-limit count instead of a silent empty result.
 */
export async function getFinnhubInsiderTransactionsWithStatus(
  ticker: string,
  daysBack: number = 180,
  opts: { asOfDate?: string } = {},
): Promise<FinnhubInsiderTxStatus> {
  try {
    // Pace through the per-invocation token bucket. Acquire blocks until
    // a token is available — without this, the scan can issue 2,000+
    // concurrent calls in seconds and Finnhub rejects most of them.
    await getFinnhubBucket().acquire();

    // When asOfDate is set, anchor the lookback to it instead of "now".
    const anchor = opts.asOfDate
      ? Date.parse(opts.asOfDate + 'T23:59:59Z')
      : Date.now();
    const from = new Date(anchor - daysBack * 86400000).toISOString().slice(0, 10);
    const to = new Date(anchor).toISOString().slice(0, 10);
    const url = `${FINNHUB}/stock/insider-transactions?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${finnhubKey()}`;
    // Patient retry envelope (~50s worst case: 2+4+8+16+20, Retry-After
    // honored): the token bucket paces OUR calls, but the API key is
    // shared with prod cron scans running in other containers — when one
    // overlaps, the minute-window blows and the default 3.5s envelope
    // exhausts long before it reopens. A PIT backtest would then book
    // TickerFailures for names the board would really have held.
    const { res, rateLimitHits, rateLimitExhausted } = await fetchWithRateLimit(url, undefined, {
      maxRetries: 5,
      initialBackoffMs: 2_000,
      maxBackoffMs: 20_000,
    });
    if (!res.ok) {
      if (res.status === 429) {
        // Logged loudly so a 429-storm shows up in Netlify function logs
        // even if the caller doesn't read the status envelope.
        console.warn(`[insider-tx] Finnhub 429 exhausted on ${ticker} after retries; flagging as rate-limited`);
        return { data: [], rateLimited: true, rateLimitExhausted: true };
      }
      return {
        data: [],
        rateLimited: rateLimitHits > 0,
        rateLimitExhausted: false,
        errorMessage: `finnhub status ${res.status}`,
      };
    }
    const data = parseOrFallback(
      FinnhubInsiderTxResponseSchema,
      await res.json(),
      { provider: 'finnhub', endpoint: opts.asOfDate ? `stock/insider-transactions:asOf=${opts.asOfDate}` : 'stock/insider-transactions', ticker },
      { data: [] },
    );
    const rows = Array.isArray(data?.data) ? data.data : [];
    let mapped = rows
      .map((r) => ({
        name: String(r.name ?? '').trim(),
        share: Number(r.share ?? 0),
        change: Number(r.change ?? 0),
        filingDate: String(r.filingDate ?? '').slice(0, 10),
        transactionDate: String(r.transactionDate ?? '').slice(0, 10),
        transactionPrice: Number(r.transactionPrice ?? 0),
        transactionCode: String(r.transactionCode ?? '').trim(),
        isDerivative: Boolean(r.isDerivative),
        source: String(r.source ?? ''),
        currency: String(r.currency ?? ''),
      }))
      .filter((r) =>
        r.name &&
        r.transactionDate &&
        Number.isFinite(r.change) &&
        Number.isFinite(r.transactionPrice)
      );

    // Defense-in-depth: re-apply filingDate filter in memory. Finnhub's
    // `to=` filter operates on transactionDate, not filingDate — so a
    // trade dated 2 days before asOfDate but filed 1 day after would
    // slip through without this guard.
    if (opts.asOfDate) {
      const cutoff = opts.asOfDate;
      mapped = mapped.filter((r) => r.filingDate && r.filingDate <= cutoff);
    }

    return {
      data: mapped,
      rateLimited: rateLimitHits > 0,
      rateLimitExhausted: false,
    };
  } catch (err: any) {
    return {
      data: [],
      rateLimited: false,
      rateLimitExhausted: false,
      errorMessage: String(err?.message ?? err),
    };
  }
}

// ---------------------------------------------------------------------------
// Finnhub recommendation trends — /stock/recommendation
//
// Returns rolling ~4 monthly snapshots of analyst rating counts. Each row
// has a `period` (YYYY-MM-DD month-start) which we treat as the PIT
// timestamp. There is no per-rating issue date in the response — we can
// only resolve to the snapshot's month.
//
// PIT strategy is hybrid:
//   - Live response covers ~last 4 months. Filter `period <= asOfDate`
//     in memory.
//   - For asOfDate older than ~4 months (or when the live response is
//     empty/missing the required period), fall back to the catalyst
//     board's snapshot store (catalyst board persists per-ticker
//     recommendation data at scan time — see scan-catalyst-*.ts).
//
// We pick `catalyst` + `sp500` as the canonical fallback source because
// the catalyst board is the broadest scan that consistently includes
// rec data per ticker. Other boards (lynch, target) may also persist
// it in some periods; this remains a known coverage limit and is
// captured in docs/POINT_IN_TIME_AUDIT.md as residual risk.
// ---------------------------------------------------------------------------

export interface RecommendationSnapshot {
  symbol: string;
  period: string;            // YYYY-MM-DD month-start
  strongBuy: number;
  buy: number;
  hold: number;
  sell: number;
  strongSell: number;
}

/**
 * Fetch analyst-rating snapshots for `ticker`.
 *
 * Default (no asOfDate): returns the live Finnhub response (~4 most
 * recent monthly snapshots, newest first).
 *
 * With asOfDate: returns snapshots whose `period` is on or before
 * asOfDate. When the live response can serve the request (asOfDate
 * within ~4 months of today), it's the preferred path. Otherwise we
 * fall back to the catalyst board's snapshot store: read the latest
 * boardSnapshot ≤ asOfDate and pull the recommendation field for
 * `ticker` from it.
 *
 * If neither path has data, returns []. We DO NOT fabricate historical
 * rating counts — empty is the honest answer.
 *
 * PIT-cacheable: keyed by (ticker, asOfDate).
 */
const RECOMMENDATIONS_LIVE_TTL_MS = 12 * 60 * 60_000;
const RECOMMENDATIONS_LIVE_EMPTY_TTL_MS = 6 * 60 * 60_000;
const recommendationsTtlMs = (rows: RecommendationSnapshot[]): number =>
  rows.length > 0 ? RECOMMENDATIONS_LIVE_TTL_MS : RECOMMENDATIONS_LIVE_EMPTY_TTL_MS;

export async function getRecommendations(
  ticker: string,
  opts: { asOfDate?: string } = {},
): Promise<RecommendationSnapshot[]> {
  // 2026-07-18 (TRIDENT) — live calls ride the shared provider cache:
  // monthly-granularity data refetched per scan per ticker was the exact
  // shape of the 07-15 incident. PIT (asOfDate) reads bypass in both
  // directions; failure-shaped results are never written (M8).
  const liveKey: LiveCacheKey | null = opts.asOfDate
    ? null
    : { provider: 'finnhub', endpoint: 'stock/recommendation', ticker, extra: 'v1' };
  if (liveKey) {
    const hit = await liveCacheGet<RecommendationSnapshot[]>(liveKey, recommendationsTtlMs);
    if (Array.isArray(hit)) return hit;
  }

  // ---- Live path (always tried first; cheap and authoritative) ----
  let live: RecommendationSnapshot[] = [];
  let liveFetchOk = false;
  try {
    const url = `${FINNHUB}/stock/recommendation?symbol=${encodeURIComponent(ticker)}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (res.ok) {
      const parsed = parseOrFallback(
        FinnhubRecommendationResponseSchema,
        await res.json(),
        { provider: 'finnhub', endpoint: 'stock/recommendation', ticker },
        [],
      );
      if (Array.isArray(parsed)) {
        liveFetchOk = true;
        live = parsed.map((r) => ({
          symbol: r.symbol ?? ticker,
          period: r.period,
          strongBuy: r.strongBuy ?? 0,
          buy: r.buy ?? 0,
          hold: r.hold ?? 0,
          sell: r.sell ?? 0,
          strongSell: r.strongSell ?? 0,
        }));
      }
    }
  } catch {
    /* swallow; fall through to filter / fallback */
  }

  // No asOfDate → return live response as-is (newest first). Cache only
  // success-shaped responses (M8: a 429/parse-fallback [] must not stick).
  if (!opts.asOfDate) {
    if (liveKey && liveFetchOk) await liveCacheSet(liveKey, live);
    return live;
  }

  // With asOfDate → filter live response by `period <= asOfDate`. The
  // live response covers a rolling window, so this serves the recent
  // backtest dates well.
  const cutoff = opts.asOfDate;
  const liveFiltered = live.filter((r) => r.period <= cutoff);
  if (liveFiltered.length > 0) return liveFiltered;

  // Live response empty for this asOfDate. Fall back to catalyst board's
  // snapshot store: read the row for `ticker` from the latest snapshot
  // ≤ asOfDate. Snapshots persist `recommendation` as the same shape
  // we return here (or close to it — defensive coercion below).
  try {
    const snap = await snapshotBeforeDate('catalyst', 'sp500', cutoff);
    if (!snap) return [];
    const row = (snap.results as any[]).find(
      (r) => r && typeof r === 'object' && r.ticker === ticker,
    );
    const rec = row?.recommendation;
    if (!rec) return [];
    return [
      {
        symbol: ticker,
        period: rec.period ?? snap.generatedAt.slice(0, 10),
        strongBuy: Number(rec.strongBuy ?? 0),
        buy: Number(rec.buy ?? 0),
        hold: Number(rec.hold ?? 0),
        sell: Number(rec.sell ?? 0),
        strongSell: Number(rec.strongSell ?? 0),
      },
    ];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// FRED macro
// ---------------------------------------------------------------------------

export interface MacroData {
  vix: number | null;
  yield10y: number | null;
  yield2y: number | null;
  spread2s10sBps: number | null;
  vixHistory?: Array<{ date: string; value: number }>;
  asOf: string;
}

/**
 * Generic FRED series fetch with vintage-date PIT support. This is the
 * gold-standard PIT case in the entire codebase: FRED's `vintage_dates`
 * parameter returns ONLY the values that were published on or before the
 * supplied date — no estimation, no fallback, just genuine PIT.
 *
 * Verified at audit time using GDPC1 (real GDP):
 *   - 2022-Q4 today:        $24,055B
 *   - 2022-Q4 vintage 2023-06-01: $20,182B (pre-revisions known then)
 *   - 2022-Q4 vintage 2024-06-01: $21,989B (after a year of revisions)
 *
 * That's a ~9% drift over a year — exactly the look-ahead bias Phase 4
 * needs to avoid.
 *
 * PIT-cacheable: keyed by (seriesId, asOfDate, observationStart, observationEnd, limit).
 */
export interface FredObservation {
  date: string;
  value: number | null;     // null when source observation is '.' (missing)
  realtimeStart?: string;
  realtimeEnd?: string;
}

export async function getFredSeries(
  seriesId: string,
  opts: {
    asOfDate?: string;
    observationStart?: string;
    observationEnd?: string;
    limit?: number;
    sortOrder?: 'asc' | 'desc';
  } = {},
): Promise<FredObservation[]> {
  try {
    const params = new URLSearchParams({
      series_id: seriesId,
      api_key: fredKey(),
      file_type: 'json',
      sort_order: opts.sortOrder ?? 'desc',
    });
    if (opts.observationStart) params.set('observation_start', opts.observationStart);
    if (opts.observationEnd) params.set('observation_end', opts.observationEnd);
    if (opts.limit) params.set('limit', String(opts.limit));
    if (opts.asOfDate) {
      // PIT: return only the values FRED had published on or before
      // asOfDate. vintage_dates accepts a single date as well as a list.
      params.set('vintage_dates', opts.asOfDate);
    }

    const url = `${FRED}/series/observations?${params}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = parseOrFallback(
      FredObservationsResponseSchema,
      await res.json(),
      {
        provider: 'fred',
        endpoint: opts.asOfDate
          ? `series/observations:${seriesId}:vintage=${opts.asOfDate}`
          : `series/observations:${seriesId}`,
      },
      { observations: [] },
    );

    return (data.observations ?? []).map((o) => {
      const value = o.value === '.' || o.value === '' ? null : Number(o.value);
      return {
        date: o.date,
        value: Number.isFinite(value as number) ? (value as number) : null,
        realtimeStart: o.realtime_start,
        realtimeEnd: o.realtime_end,
      };
    });
  } catch {
    return [];
  }
}

async function fredLatestObservation(
  seriesId: string,
  asOfDate?: string,
): Promise<number | null> {
  const obs = await getFredSeries(seriesId, {
    asOfDate,
    sortOrder: 'desc',
    limit: 10,
  });
  for (const o of obs) {
    if (o.value !== null) return o.value;
  }
  return null;
}

async function fredSeries(
  seriesId: string,
  days: number,
  asOfDate?: string,
): Promise<Array<{ date: string; value: number }>> {
  const obs = await getFredSeries(seriesId, {
    asOfDate,
    sortOrder: 'desc',
    limit: days,
  });
  return obs
    .filter((o) => o.value !== null)
    .map((o) => ({ date: o.date, value: o.value as number }))
    .reverse();
}

/**
 * Macro snapshot: VIX + yield curve. Default returns latest values.
 * With `asOfDate`, every underlying series is read at FRED vintage
 * `asOfDate`, giving genuinely PIT-correct macro context for backtests.
 *
 * PIT-cacheable: keyed by (asOfDate).
 */
export async function getMacroData(
  opts: { asOfDate?: string } = {},
): Promise<MacroData> {
  const [vix, y10, y2, vixHistory] = await Promise.all([
    fredLatestObservation('VIXCLS', opts.asOfDate),
    fredLatestObservation('DGS10', opts.asOfDate),
    fredLatestObservation('DGS2', opts.asOfDate),
    fredSeries('VIXCLS', 90, opts.asOfDate),
  ]);

  const spread2s10sBps = y10 !== null && y2 !== null ? Math.round((y10 - y2) * 100) : null;

  return {
    vix,
    yield10y: y10,
    yield2y: y2,
    spread2s10sBps,
    vixHistory,
    asOf: opts.asOfDate
      ? `${opts.asOfDate}T23:59:59.999Z`
      : new Date().toISOString(),
  };
}
