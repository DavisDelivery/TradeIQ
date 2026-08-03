// Batched live-quote fetcher (Polygon market snapshot).
//
// The boards render price + intraday %-change straight from their daily
// snapshot, which is scored once by the scheduled scan and then frozen for
// the rest of the day. This module fetches CURRENT price + today's % change
// for a set of tickers so the UI can overlay live values on top of the
// (necessarily older) scored snapshot.
//
// One Polygon "full-market snapshot" call returns every requested ticker in
// a single round-trip (chunked at 100 to stay well under URL limits), so a
// 50-card board costs one upstream call, not 50.
//
// Resilient by design: any chunk that errors is skipped, and tickers the
// upstream omits simply fall through to the snapshot value on the client.
// Callers treat a missing entry as "no live quote, keep the scored price."

import { fetchFinvizQuotes, finvizEnabled } from './finviz';

const POLYGON = 'https://api.polygon.io';

export interface LiveQuote {
  /** Latest trade price (falls back to last minute/day/prev-day close). */
  price: number;
  /** Today's % change vs prior close. 0 when the market is closed/unknown. */
  changePct: number;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Fetch live quotes for a set of tickers. Returns a map keyed by uppercased
 * ticker; tickers with no usable price are omitted (caller falls back to the
 * scored snapshot value). Never throws on a single-chunk upstream failure —
 * it returns whatever chunks succeeded.
 */
export async function getLiveQuotes(tickers: string[]): Promise<Record<string, LiveQuote>> {
  const uniq = [...new Set(tickers.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
  const out: Record<string, LiveQuote> = {};
  if (uniq.length === 0) return out;

  // FVZ-4: Finviz first. Its screener takes an arbitrary ticker LIST and
  // answered all 503 S&P names in ONE call (measured) versus Polygon's
  // 100-per-call snapshot — and this is the highest-frequency upstream we
  // have, polled every 15-30s per open board while the market is open.
  //
  // Whatever Finviz misses (an uncovered symbol, a throttle) falls through
  // to Polygon below, so a partial answer degrades instead of blanking the
  // price overlay.
  if (finvizEnabled()) {
    try {
      const quotes = await fetchFinvizQuotes(uniq);
      if (quotes) {
        for (const q of quotes) {
          if (q.price == null || q.price <= 0) continue;
          out[q.ticker.toUpperCase()] = {
            price: round2(q.price),
            changePct: q.changePct == null ? 0 : round2(q.changePct),
          };
        }
      }
    } catch {
      // Never let the new path break the overlay.
    }
  }

  const missing = uniq.filter((t) => !(t in out));
  if (missing.length === 0) return out;

  const key = process.env.POLYGON_API_KEY;
  // Finviz alone is a complete answer when Polygon is deconfigured; only
  // the residual tickers would have been backfilled.
  if (!key) {
    if (Object.keys(out).length > 0) return out;
    throw new Error('POLYGON_API_KEY not set');
  }

  return backfillFromPolygon(missing, out, key);
}

async function backfillFromPolygon(
  uniq: string[],
  out: Record<string, LiveQuote>,
  key: string,
): Promise<Record<string, LiveQuote>> {
  const CHUNK = 100;
  for (let i = 0; i < uniq.length; i += CHUNK) {
    const chunk = uniq.slice(i, i + CHUNK);
    const url = `${POLYGON}/v2/snapshot/locale/us/markets/stocks/tickers?tickers=${chunk.join(',')}&apiKey=${key}`;
    let res: Response;
    try {
      res = await fetch(url);
    } catch {
      continue; // transport failure on this chunk — skip, keep the rest
    }
    if (!res.ok) continue;
    const data: any = await res.json().catch(() => null);
    const arr = data?.tickers;
    if (!Array.isArray(arr)) continue;
    for (const t of arr) {
      const sym = typeof t?.ticker === 'string' ? t.ticker.toUpperCase() : null;
      if (!sym) continue;
      // Live-price preference: a real last trade, then the latest minute
      // bar, then today's bar, then the prior close as a final floor.
      const price =
        num(t?.lastTrade?.p) ??
        num(t?.min?.c) ??
        num(t?.day?.c) ??
        num(t?.prevDay?.c);
      if (price == null || price <= 0) continue;
      const changePct = num(t?.todaysChangePerc);
      out[sym] = { price: round2(price), changePct: changePct == null ? 0 : round2(changePct) };
    }
  }
  return out;
}
