// Unified market data provider — Polygon (bars, fundamentals, news, snapshots)
// + Finnhub (earnings, recommendations) + FRED (macro rates, VIX).

import {
  PolygonAggregatesResponseSchema,
  PolygonFinancialsResponseSchema,
  PolygonNewsResponseSchema,
  FinnhubEarningsCalendarResponseSchema,
  FinnhubEarningsHistoryResponseSchema,
  FinnhubInsiderTxResponseSchema,
  FinnhubRecommendationResponseSchema,
  FredObservationsResponseSchema,
  parseOrFallback,
} from './schemas';
import { snapshotBeforeDate } from './snapshot-store';

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
  ticker: string;
  revenue?: number;
  priorRevenue?: number;
  revenueGrowthYoY?: number;
  eps?: number;
  priorEps?: number;
  epsGrowthYoY?: number;
  ttmEps?: number;
  grossMargin?: number;
  operatingMargin?: number;
  priorOperatingMargin?: number;
  debtToEquity?: number;
  asOf?: string;
}

/**
 * Estimate a filing date for a Polygon financials row when `filing_date`
 * is null (common for 10-K annuals on this Polygon plan). The SEC's
 * non-large filer 10-K deadline is 90 days post-period; large filers
 * file in 60-75 days. We pick 75 as a conservative middle so the PIT
 * filter doesn't silently exclude annuals that were public on `asOfDate`.
 *
 * Worst-case error is ±15 days, which is documented in
 * docs/POINT_IN_TIME_AUDIT.md as residual risk. For backtests at monthly
 * or quarterly cadence this is immaterial.
 */
function estimateFilingDate(endDate: string | undefined, fiscalPeriod: string | undefined): string | undefined {
  if (!endDate) return undefined;
  // 10-K (annual): ~75 day SEC deadline. 10-Q (quarterly): ~40 days but
  // Polygon's response usually includes filing_date for 10-Qs, so we hit
  // this branch mostly for Q4/FY filings.
  const lagDays = fiscalPeriod === 'Q4' || fiscalPeriod === 'FY' ? 75 : 40;
  const t = Date.parse(endDate);
  if (!Number.isFinite(t)) return undefined;
  return new Date(t + lagDays * 86400000).toISOString().slice(0, 10);
}

/**
 * Fetch a fundamentals snapshot for `ticker`. Returns a normalized view
 * computed from up to 5 most recent quarterly filings.
 *
 * PIT semantics: when `asOfDate` is supplied, only filings public on or
 * before `asOfDate` are considered for the snapshot. The "as-of" filter
 * is applied at TWO layers for safety:
 *   1. Server-side via Polygon's `filing_date.lte` query parameter.
 *   2. In-memory via `(filing_date ?? estimateFilingDate(...)) <= asOfDate`,
 *      because Polygon's API omits the filter when filing_date is null
 *      AND because the API-side filter is treated as advisory (we always
 *      verify in memory).
 *
 * RESIDUAL RISK: Polygon silently incorporates restatement edits into
 * past filings — values returned today for a filing dated 2022-06-15 may
 * differ from what was public on 2022-06-15 if the company restated.
 * The proper fix is snapshotting fundamentals into the boardSnapshots
 * store at scan time (Phase 1 schema extension, out of scope for Phase 3).
 *
 * PIT-cacheable: keyed by (ticker, asOfDate).
 *
 * See docs/POINT_IN_TIME_AUDIT.md for the full audit.
 */
export async function getFundamentals(
  ticker: string,
  opts: { asOfDate?: string } = {},
): Promise<FundamentalsSnapshot | null> {
  try {
    const filingFilter = opts.asOfDate
      ? `&filing_date.lte=${encodeURIComponent(opts.asOfDate)}`
      : '';
    const url = `${POLYGON}/vX/reference/financials?ticker=${ticker}&limit=5&timeframe=quarterly&order=desc${filingFilter}&apiKey=${polygonKey()}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = parseOrFallback(
      PolygonFinancialsResponseSchema,
      await res.json(),
      { provider: 'polygon', endpoint: opts.asOfDate ? `financials:asOf=${opts.asOfDate}` : 'financials', ticker },
      { results: [] },
    );
    let results = (data.results ?? []) as any[];

    // Defense-in-depth: re-apply the filter in memory using the estimate
    // fallback for null filing_dates. We don't trust the server to honor
    // filing_date.lte when filing_date is missing on the row.
    if (opts.asOfDate) {
      const cutoff = opts.asOfDate;
      results = results.filter((r) => {
        const fd = r.filing_date ?? estimateFilingDate(r.end_date, r.fiscal_period);
        return fd !== undefined && fd <= cutoff;
      });
    }

    if (results.length === 0) return null;

    const latest = results[0];
    const prior = results[1];
    const yearAgo = results[3];

    const revenue = num(latest.financials?.income_statement?.revenues);
    const priorRevenue = num(yearAgo?.financials?.income_statement?.revenues);
    const eps = num(latest.financials?.income_statement?.basic_earnings_per_share);
    const priorEpsYoY = num(yearAgo?.financials?.income_statement?.basic_earnings_per_share);
    const grossProfit = num(latest.financials?.income_statement?.gross_profit);
    const opIncome = num(latest.financials?.income_statement?.operating_income_loss);
    const priorOpIncome = num(prior?.financials?.income_statement?.operating_income_loss);
    const priorRev = num(prior?.financials?.income_statement?.revenues);
    const debt = num(latest.financials?.balance_sheet?.long_term_debt);
    const equity = num(latest.financials?.balance_sheet?.equity);

    const ttmEps = results
      .slice(0, 4)
      .map((r) => num(r.financials?.income_statement?.basic_earnings_per_share) ?? 0)
      .reduce((a, b) => a + b, 0);

    return {
      ticker,
      revenue,
      priorRevenue,
      revenueGrowthYoY:
        revenue !== undefined && priorRevenue !== undefined && priorRevenue !== 0
          ? (revenue - priorRevenue) / priorRevenue
          : undefined,
      eps,
      priorEps: priorEpsYoY,
      epsGrowthYoY:
        eps !== undefined && priorEpsYoY !== undefined && priorEpsYoY !== 0
          ? (eps - priorEpsYoY) / Math.abs(priorEpsYoY)
          : undefined,
      ttmEps,
      grossMargin:
        revenue !== undefined && grossProfit !== undefined && revenue !== 0
          ? grossProfit / revenue
          : undefined,
      operatingMargin:
        revenue !== undefined && opIncome !== undefined && revenue !== 0
          ? opIncome / revenue
          : undefined,
      priorOperatingMargin:
        priorRev !== undefined && priorOpIncome !== undefined && priorRev !== 0
          ? priorOpIncome / priorRev
          : undefined,
      debtToEquity:
        debt !== undefined && equity !== undefined && equity !== 0
          ? debt / equity
          : undefined,
      asOf: latest.end_date,
    };
  } catch {
    return null;
  }
}

function num(v: unknown): number | undefined {
  if (v && typeof v === 'object' && 'value' in v) {
    const n = Number((v as any).value);
    return Number.isFinite(n) ? n : undefined;
  }
  if (typeof v === 'number') return v;
  return undefined;
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

export async function getEarningsCalendarRange(
  daysAhead = 14,
  daysBack = 0,
): Promise<UpcomingEarning[]> {
  try {
    const from = new Date(Date.now() - Math.max(0, daysBack) * 86400000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
    const url = `${FINNHUB}/calendar/earnings?from=${from}&to=${to}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) {
      // 429 from Finnhub means the per-minute limit was hit by an adjacent
      // function in the same cold-start. Log it so deploys surface this in
      // function logs instead of silently returning empty.
      if (res.status === 429) {
        console.warn('[earnings-cal] Finnhub 429 rate-limited; returning empty so caller skips cache');
      }
      return [];
    }
    const data = parseOrFallback(
      FinnhubEarningsCalendarResponseSchema,
      await res.json(),
      { provider: 'finnhub', endpoint: 'calendar/earnings/range' },
      { earningsCalendar: [] },
    );
    return (data.earningsCalendar ?? []).map((e) => ({
      ticker: e.symbol,
      date: e.date,
      hour: e.hour,
      epsEstimate: e.epsEstimate ?? undefined,
      revenueEstimate: e.revenueEstimate ?? undefined,
    }));
  } catch {
    return [];
  }
}

export interface EarningsSurprise {
  date: string;
  epsActual: number;
  epsEstimate: number;
  surprisePct?: number;
}

/**
 * PIT-cacheable: keyed by (ticker, limit, asOfDate).
 *
 * When asOfDate is supplied, drops any report whose period > asOfDate.
 * The provider returns up to `limit` most-recent reports, and a backtest
 * at past date T must not see reports filed after T.
 */
export async function getEarningsHistory(
  ticker: string,
  limit = 8,
  opts: { asOfDate?: string } = {},
): Promise<EarningsSurprise[]> {
  try {
    // Fetch extra to absorb post-filter losses when asOfDate is set.
    const fetchLimit = opts.asOfDate ? Math.max(limit * 4, 32) : limit;
    const url = `${FINNHUB}/stock/earnings?symbol=${ticker}&limit=${fetchLimit}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = parseOrFallback(
      FinnhubEarningsHistoryResponseSchema,
      await res.json(),
      { provider: 'finnhub', endpoint: 'stock/earnings', ticker },
      [],
    );
    if (!Array.isArray(data)) return [];
    let rows = data
      .map((r) => ({
        date: r.period,
        epsActual: Number(r.actual),
        epsEstimate: Number(r.estimate),
        surprisePct: r.surprisePercent !== undefined ? Number(r.surprisePercent) : undefined,
      }))
      .filter((r) => Number.isFinite(r.epsActual) && Number.isFinite(r.epsEstimate));
    if (opts.asOfDate) {
      rows = rows.filter((r) => r.date <= opts.asOfDate!);
    }
    return rows.slice(0, limit);
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
 * PIT-cacheable: keyed by (ticker, asOfDate, daysBack).
 */
export async function getFinnhubInsiderTransactions(
  ticker: string,
  daysBack: number = 180,
  opts: { asOfDate?: string } = {},
): Promise<FinnhubInsiderTx[]> {
  try {
    // When asOfDate is set, anchor the lookback to it instead of "now".
    const anchor = opts.asOfDate
      ? Date.parse(opts.asOfDate + 'T23:59:59Z')
      : Date.now();
    const from = new Date(anchor - daysBack * 86400000).toISOString().slice(0, 10);
    const to = new Date(anchor).toISOString().slice(0, 10);
    const url = `${FINNHUB}/stock/insider-transactions?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[insider-tx] Finnhub 429 on ${ticker}; returning empty`);
      }
      return [];
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

    return mapped;
  } catch {
    return [];
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
export async function getRecommendations(
  ticker: string,
  opts: { asOfDate?: string } = {},
): Promise<RecommendationSnapshot[]> {
  // ---- Live path (always tried first; cheap and authoritative) ----
  let live: RecommendationSnapshot[] = [];
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

  // No asOfDate → return live response as-is (newest first).
  if (!opts.asOfDate) return live;

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
