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
import { getFinnhubBucket, fetchWithRateLimit } from './rate-limiter';

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

// SEC's WAF BLOCKS a `users.noreply.github.com` contact address in the UA
// (403 regardless of other headers); a real deliverable email returns 200.
// Verified: noreply → 403, chad@davisdelivery.com → 200. Use the real email.
const EDGAR_UA = 'TradeIQ Alpha chad@davisdelivery.com';
// SEC's Akamai WAF fingerprints requests that lack a browser-like header set
// and 403s them regardless of IP (verified: UA+gzip alone → 403; adding
// accept + accept-language → 200). Send the full set on every EDGAR call.
const EDGAR_HEADERS: Record<string, string> = {
  'user-agent': EDGAR_UA,
  accept: 'application/json, text/plain, text/html, */*',
  'accept-language': 'en-US,en;q=0.9',
  'accept-encoding': 'gzip, deflate',
};
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
  const res = await fetch(url, { headers: EDGAR_HEADERS });
  if (res.status === 429 || res.status === 403) {
    // SEC's WAF serves "Request Rate Threshold Exceeded" 403s that flag the
    // EGRESS IP (shared on Netlify) for ~10 minutes — a 5s retry was far too
    // impatient and killed the first E3 backfill on its very first request.
    // Ladder: 15s, then 100s. Still blocked => THROW; the checkpointed job
    // records failure and a later resume retries after the flag lifts.
    const log = logger.child({ fn: 'vector-data' });
    for (const waitMs of [15_000, 100_000]) {
      log.warn('edgar_throttled', { url, status: res.status, waitMs });
      await new Promise((r) => setTimeout(r, waitMs));
      await edgarThrottle();
      const retry = await fetch(url, { headers: EDGAR_HEADERS });
      if (retry.ok) return retry;
      if (retry.status !== 429 && retry.status !== 403) {
        throw new Error(`edgar ${url}: HTTP ${retry.status} after backoff`);
      }
    }
    throw new Error(`edgar ${url}: HTTP 403 rate-threshold persisted through backoff ladder`);
  }
  if (!res.ok) throw new Error(`edgar ${url}: HTTP ${res.status}`);
  return res;
}

/**
 * Per-ticker daily aggs with an entitlement-floor retry: the current
 * Polygon plan serves ~10 years of history and 403s below it. On a 403,
 * retry once from (today - 9.5y); if that also fails, THROW. The clamp is
 * RECORDED by returning `clampedFrom` so callers can surface it — a
 * shortened series is a fact, never a silent substitution.
 */
export async function getDailyBarsClamped(
  ticker: string,
  from: string,
  to: string,
): Promise<{ bars: { t: number; o: number; h: number; l: number; c: number; v: number }[]; clampedFrom: string | null }> {
  const url = (f: string) =>
    `${POLYGON}/v2/aggs/ticker/${encodeURIComponent(ticker)}/range/1/day/${f}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${polygonKey()}`;
  let res = await fetch(url(from));
  let clampedFrom: string | null = null;
  if (res.status === 403) {
    clampedFrom = new Date(Date.now() - Math.floor(9.5 * 365.25) * 86_400_000).toISOString().slice(0, 10);
    res = await fetch(url(clampedFrom));
  }
  if (!res.ok) throw new Error(`polygon bars ${ticker}: HTTP ${res.status}${clampedFrom ? ' (after floor clamp)' : ''}`);
  const data = (await res.json()) as { results?: any[] };
  return { bars: (data.results ?? []) as any[], clampedFrom };
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

// ---------------------------------------------------------------------
// Finnhub — per-symbol earnings calendar (historical hour resolution)
// ---------------------------------------------------------------------

export interface EarningsCalRow {
  date: string;
  hour: 'bmo' | 'amc' | 'dmh' | '';
}

/**
 * Per-symbol earnings calendar over an explicit historical range. Depth is
 * plan-dependent (#107: history may cap at recent quarters) — callers must
 * treat a missing date as "hour unknown" and fall back, never fabricate.
 * Non-OK => THROW (nothing cached).
 */
export async function getEarningsCalendarForSymbol(
  ticker: string,
  from: string,
  to: string,
): Promise<EarningsCalRow[]> {
  const key = process.env.FINNHUB_API_KEY;
  if (!key) throw new Error('FINNHUB_API_KEY unset');
  await getFinnhubBucket().acquire();
  const url = `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&symbol=${encodeURIComponent(ticker)}&token=${key}`;
  const { res } = await fetchWithRateLimit(url, undefined);
  if (!res.ok) throw new Error(`finnhub calendar ${ticker}: HTTP ${res.status}`);
  const data = (await res.json()) as { earningsCalendar?: { date?: string; hour?: string }[] };
  return (data.earningsCalendar ?? [])
    .filter((e) => e.date)
    .map((e) => ({ date: e.date as string, hour: (e.hour ?? '') as EarningsCalRow['hour'] }));
}
