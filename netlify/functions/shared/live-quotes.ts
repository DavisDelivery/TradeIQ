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
  const key = process.env.POLYGON_API_KEY;
  if (!key) throw new Error('POLYGON_API_KEY not set');

  const uniq = [...new Set(tickers.map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))];
  const out: Record<string, LiveQuote> = {};
  if (uniq.length === 0) return out;

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
