// Unified market data provider — Polygon (bars, fundamentals, news, snapshots)
// + Finnhub (earnings, recommendations) + FRED (macro rates, VIX).

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

export async function getDailyBars(
  ticker: string,
  from: string,
  to: string,
): Promise<Bar[]> {
  const url = `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${from}/${to}?adjusted=true&sort=asc&limit=5000&apiKey=${polygonKey()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Polygon bars ${ticker}: ${res.status}`);
  const data = (await res.json()) as { results?: Bar[] };
  return data.results ?? [];
}

export async function getPreviousClose(ticker: string): Promise<Bar | null> {
  const url = `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev?adjusted=true&apiKey=${polygonKey()}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const data = (await res.json()) as { results?: Bar[] };
  return data.results?.[0] ?? null;
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

export async function getFundamentals(
  ticker: string,
): Promise<FundamentalsSnapshot | null> {
  try {
    const url = `${POLYGON}/vX/reference/financials?ticker=${ticker}&limit=5&timeframe=quarterly&order=desc&apiKey=${polygonKey()}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: any[] };
    const results = data.results ?? [];
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

export async function getNews(ticker: string, limit = 20): Promise<NewsItem[]> {
  try {
    const url = `${POLYGON}/v2/reference/news?ticker=${ticker}&limit=${limit}&order=desc&sort=published_utc&apiKey=${polygonKey()}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { results?: any[] };
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

export async function getUpcomingEarnings(
  ticker: string,
  daysAhead = 60,
): Promise<UpcomingEarning | null> {
  try {
    const from = new Date().toISOString().slice(0, 10);
    const to = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
    const url = `${FINNHUB}/calendar/earnings?from=${from}&to=${to}&symbol=${ticker}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { earningsCalendar?: any[] };
    const first = data.earningsCalendar?.[0];
    if (!first) return null;
    return {
      ticker,
      date: first.date,
      hour: first.hour,
      epsEstimate: first.epsEstimate,
      revenueEstimate: first.revenueEstimate,
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
    const data = (await res.json()) as { earningsCalendar?: any[] };
    return (data.earningsCalendar ?? []).map((e) => ({
      ticker: e.symbol,
      date: e.date,
      hour: e.hour,
      epsEstimate: e.epsEstimate,
      revenueEstimate: e.revenueEstimate,
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

export async function getEarningsHistory(ticker: string, limit = 8): Promise<EarningsSurprise[]> {
  try {
    const url = `${FINNHUB}/stock/earnings?symbol=${ticker}&limit=${limit}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as any[];
    if (!Array.isArray(data)) return [];
    return data
      .map((r) => ({
        date: r.period,
        epsActual: Number(r.actual),
        epsEstimate: Number(r.estimate),
        surprisePct: r.surprisePercent !== undefined ? Number(r.surprisePercent) : undefined,
      }))
      .filter((r) => Number.isFinite(r.epsActual) && Number.isFinite(r.epsEstimate));
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

export async function getFinnhubInsiderTransactions(
  ticker: string,
  daysBack: number = 180,
): Promise<FinnhubInsiderTx[]> {
  try {
    const from = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
    const to = new Date().toISOString().slice(0, 10);
    const url = `${FINNHUB}/stock/insider-transactions?symbol=${encodeURIComponent(ticker)}&from=${from}&to=${to}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) {
      if (res.status === 429) {
        console.warn(`[insider-tx] Finnhub 429 on ${ticker}; returning empty`);
      }
      return [];
    }
    const data = (await res.json()) as { data?: any[] };
    const rows = Array.isArray(data?.data) ? data.data : [];
    return rows
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

async function fredLatestObservation(seriesId: string): Promise<number | null> {
  try {
    const url = `${FRED}/series/observations?series_id=${seriesId}&api_key=${fredKey()}&file_type=json&sort_order=desc&limit=10`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
    for (const obs of data.observations ?? []) {
      if (obs.value !== '.' && obs.value !== '') {
        const v = Number(obs.value);
        if (Number.isFinite(v)) return v;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function fredSeries(seriesId: string, days: number): Promise<Array<{ date: string; value: number }>> {
  try {
    const url = `${FRED}/series/observations?series_id=${seriesId}&api_key=${fredKey()}&file_type=json&sort_order=desc&limit=${days}`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as { observations?: Array<{ date: string; value: string }> };
    return (data.observations ?? [])
      .filter((o) => o.value !== '.' && o.value !== '')
      .map((o) => ({ date: o.date, value: Number(o.value) }))
      .filter((o) => Number.isFinite(o.value))
      .reverse();
  } catch {
    return [];
  }
}

export async function getMacroData(): Promise<MacroData> {
  const [vix, y10, y2, vixHistory] = await Promise.all([
    fredLatestObservation('VIXCLS'),
    fredLatestObservation('DGS10'),
    fredLatestObservation('DGS2'),
    fredSeries('VIXCLS', 90),
  ]);

  const spread2s10sBps = y10 !== null && y2 !== null ? Math.round((y10 - y2) * 100) : null;

  return {
    vix,
    yield10y: y10,
    yield2y: y2,
    spread2s10sBps,
    vixHistory,
    asOf: new Date().toISOString(),
  };
}
