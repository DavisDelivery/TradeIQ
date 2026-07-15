// VECTOR — data access for the ingest/backfill jobs.
//
// Three vendors, three disciplines:
//   Polygon — grouped-daily bars (whole market incl. delisted, one call
//             per trading day) + full reference universe. Failures THROW.
//   Massive — PIT quarterly income statements (EPS + filing dates) via
//             the existing massive-fundamentals client.
//   EDGAR   — daily form indexes + company_tickers.json. UA header
//             required by SEC policy; hard-capped at 8 req/s.

import { logger } from './logger';

const POLYGON = 'https://api.polygon.io';
const polygonKey = () => {
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error('POLYGON_API_KEY unset');
  return k;
};

export interface GroupedRow {
  /** ticker */
  T: string;
  c: number;
  h: number;
  l: number;
  o: number;
  v: number;
  /** epoch ms */
  t: number;
}

/**
 * All US stocks' OHLCV for one trading day — includes tickers that later
 * delisted, which is what makes the hygiene universe survivorship-proof.
 * Non-OK responses THROW (4t-W1c: never cache an error-shaped empty).
 * An empty results array on an OK response means a non-trading day.
 */
export async function getGroupedDaily(date: string): Promise<GroupedRow[]> {
  const url = `${POLYGON}/v2/aggs/grouped/locale/us/market/stocks/${date}?adjusted=true&apiKey=${polygonKey()}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`polygon grouped ${date}: HTTP ${res.status}`);
  const data = (await res.json()) as { results?: GroupedRow[]; resultsCount?: number };
  return data.results ?? [];
}

/** Ticker reference row (active + delisted). */
export interface TickerRef {
  ticker: string;
  name: string | null;
  type: string | null;
  active: boolean;
  cik: string | null;
  compositeFigi: string | null;
  sicDescription: string | null;
  delistedUtc: string | null;
}

/**
 * Full Polygon reference universe, one page at a time (cursor param), so
 * a checkpointed caller can resume mid-listing. Common stocks only is the
 * caller's filter (type CS) — we return what Polygon returns.
 */
export async function getTickerRefPage(
  cursorUrl: string | null,
  active: boolean,
): Promise<{ rows: TickerRef[]; nextCursorUrl: string | null }> {
  const url =
    cursorUrl ??
    `${POLYGON}/v3/reference/tickers?market=stocks&active=${active}&limit=1000&apiKey=${polygonKey()}`;
  // Cursor URLs from Polygon omit the key.
  const withKey = url.includes('apiKey=') ? url : `${url}&apiKey=${polygonKey()}`;
  const res = await fetch(withKey);
  if (!res.ok) throw new Error(`polygon reference (active=${active}): HTTP ${res.status}`);
  const data = (await res.json()) as {
    results?: any[];
    next_url?: string;
  };
  const rows: TickerRef[] = (data.results ?? []).map((r) => ({
    ticker: r.ticker,
    name: r.name ?? null,
    type: r.type ?? null,
    active: r.active ?? active,
    cik: r.cik ?? null,
    compositeFigi: r.composite_figi ?? null,
    sicDescription: r.sic_description ?? null,
    delistedUtc: r.delisted_utc ?? null,
  }));
  return { rows, nextCursorUrl: data.next_url ?? null };
}

// ---------------------------------------------------------------------
// EDGAR — UA + 8 req/s cap (SEC fair-access policy)
// ---------------------------------------------------------------------

const EDGAR_UA = 'TradeIQ research davisdelivery@users.noreply.github.com';
let edgarWindow: number[] = [];

async function edgarThrottle(): Promise<void> {
  // Sliding 1s window, max 8 requests.
  for (;;) {
    const now = Date.now();
    edgarWindow = edgarWindow.filter((t) => now - t < 1000);
    if (edgarWindow.length < 8) {
      edgarWindow.push(now);
      return;
    }
    await new Promise((r) => setTimeout(r, 60));
  }
}

export async function edgarFetch(url: string): Promise<Response> {
  await edgarThrottle();
  const res = await fetch(url, { headers: { 'user-agent': EDGAR_UA, 'accept-encoding': 'gzip' } });
  if (res.status === 429 || res.status === 403) {
    // Back off hard once, then retry once; still failing => THROW.
    logger.child({ fn: 'vector-data' }).warn('edgar_throttled', { url, status: res.status });
    await new Promise((r) => setTimeout(r, 5000));
    await edgarThrottle();
    const retry = await fetch(url, { headers: { 'user-agent': EDGAR_UA } });
    if (!retry.ok) throw new Error(`edgar ${url}: HTTP ${retry.status} after backoff`);
    return retry;
  }
  if (!res.ok) throw new Error(`edgar ${url}: HTTP ${res.status}`);
  return res;
}

/** CIK (10-digit, zero-padded) -> ticker map from company_tickers.json. */
export async function getCikTickerMap(): Promise<Map<string, string>> {
  const res = await edgarFetch('https://www.sec.gov/files/company_tickers.json');
  const data = (await res.json()) as Record<string, { cik_str: number; ticker: string }>;
  const map = new Map<string, string>();
  for (const row of Object.values(data)) {
    map.set(String(row.cik_str).padStart(10, '0'), row.ticker.toUpperCase());
  }
  return map;
}

/** EDGAR daily form index URL for a date (quarters are calendar). */
export function dailyIndexUrl(date: string): string {
  const [y, m] = date.split('-').map(Number);
  const q = Math.floor((m - 1) / 3) + 1;
  const compact = date.replace(/-/g, '');
  return `https://www.sec.gov/Archives/edgar/daily-index/${y}/QTR${q}/form.${compact}.idx`;
}
