// Phase 4f W4 — Polygon equity trades fetcher (sample-based).
//
// Polygon's /v3/trades endpoint returns every print for a ticker on
// a given day. For a large-cap with ~M trades/day, fetching every
// page is unbounded; the scheduled scan can't afford that.
//
// Strategy: fetch up to MAX_PAGES (default 5) at 50,000 trades per
// page. That's up to 250K trades per ticker per day — typically
// covering the full session for any name with < ~500K daily trades,
// and providing a statistically meaningful sample for the rest.
//
// Returns the raw trades plus a flag indicating whether the sample
// was truncated. Downstream signals (dark-pool, block-trades) are
// robust to truncation because they compute ratios + counts, not
// totals — a truncated sample still produces the correct ratio.

import type { PolygonTrade } from './types';

const POLYGON_BASE = 'https://api.polygon.io';
const PAGE_LIMIT = 50_000;

export interface PolygonTradesResult {
  trades: PolygonTrade[];
  pagesFetched: number;
  truncated: boolean;
  warnings: string[];
}

interface PolygonTradeRaw {
  participant_timestamp?: number;
  sip_timestamp?: number;
  price?: number;
  size?: number;
  exchange?: number;
  conditions?: number[];
}

function polygonKey(): string {
  const k = process.env.POLYGON_API_KEY;
  if (!k) throw new Error('POLYGON_API_KEY not set');
  return k;
}

function normalize(rawList: PolygonTradeRaw[]): PolygonTrade[] {
  const out: PolygonTrade[] = [];
  for (const r of rawList) {
    const t = r.sip_timestamp ?? r.participant_timestamp;
    const p = r.price;
    const s = r.size;
    if (t == null || p == null || s == null) continue;
    // Polygon timestamps are nanoseconds — convert to ms.
    out.push({
      t: Math.floor(t / 1_000_000),
      p,
      s,
      x: r.exchange,
      c: r.conditions,
    });
  }
  return out;
}

/**
 * Fetch a sample of trades for `ticker` on `date`. Up to MAX_PAGES
 * pages × PAGE_LIMIT trades each. Caller can use the result to
 * compute ratio-based signals (dark-pool fraction, block counts).
 */
export async function getTradesForDay(
  ticker: string,
  date: string,
  maxPages = 5,
): Promise<PolygonTradesResult> {
  const trades: PolygonTrade[] = [];
  const warnings: string[] = [];
  // Polygon timestamp filter is on `participant_timestamp` or
  // `sip_timestamp` in nanoseconds. We use the timestamp range to
  // pin the request to one calendar day in US/Eastern.
  const startMs = Date.parse(`${date}T00:00:00Z`);
  const endMs = startMs + 86_400_000;
  const startNs = startMs * 1_000_000;
  const endNs = endMs * 1_000_000;
  let url: string | null =
    `${POLYGON_BASE}/v3/trades/${encodeURIComponent(ticker)}` +
    `?timestamp.gte=${startNs}&timestamp.lt=${endNs}` +
    `&limit=${PAGE_LIMIT}&order=asc&apiKey=${polygonKey()}`;
  let pagesFetched = 0;
  while (url && pagesFetched < maxPages) {
    const res = await fetch(url);
    if (!res.ok) {
      warnings.push(`polygon ${ticker} ${date}: HTTP ${res.status}`);
      break;
    }
    const body = (await res.json()) as {
      results?: PolygonTradeRaw[];
      next_url?: string;
    };
    if (body.results) trades.push(...normalize(body.results));
    pagesFetched++;
    if (body.next_url) {
      // next_url returned WITHOUT the api key — append it.
      url = body.next_url.includes('apiKey=')
        ? body.next_url
        : `${body.next_url}&apiKey=${polygonKey()}`;
    } else {
      url = null;
    }
  }
  return {
    trades,
    pagesFetched,
    truncated: pagesFetched >= maxPages,
    warnings,
  };
}
