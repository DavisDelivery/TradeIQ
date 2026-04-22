// Shared Quiver Quantitative API client. All providers that need Quiver data
// route through here so auth, caching, rate handling, and error behavior live
// in one place.
//
// Base: https://api.quiverquant.com/beta
// Auth: Authorization: Token <key>
//
// Endpoint families used:
//   /historical/insiders/{ticker}        — SEC Form 4 insider transactions
//   /historical/allpatents/{ticker}      — patent grants
//   /historical/senatetrading/{ticker}   — senator disclosures (STOCK Act)
//   /historical/housetrading/{ticker}    — house rep disclosures
//   /historical/govcontractsall/{ticker} — federal contract awards
//   /historical/lobbying/{ticker}        — corporate lobbying spend
//   /historical/wallstreetbets/{ticker}  — WSB mention counts
//
// The "live" variants of these (no ticker path, no query param) return recent
// activity across all tickers — useful for board-wide scans where pulling
// per-ticker would be expensive.

const QUIVER_BASE = 'https://api.quiverquant.com/beta';

function quiverKey(): string {
  const k = process.env.QUIVER_API_KEY;
  if (!k) throw new Error('QUIVER_API_KEY not set');
  return k;
}

// Shared in-memory cache across all Quiver calls. Keyed by URL; lambdas get a
// fresh cache on cold-start, warm invocations reuse it. 10-minute TTL is a
// reasonable default — most Quiver datasets update daily, some hourly.
const cache = new Map<string, { data: any; at: number }>();
const DEFAULT_TTL_MS = 10 * 60 * 1000;

export async function quiverGet<T = any>(
  path: string,
  opts: { ttlMs?: number } = {},
): Promise<T | null> {
  const url = `${QUIVER_BASE}${path}`;
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.data as T;

  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        Authorization: `Token ${quiverKey()}`,
      },
    });

    // 403 usually means the dataset isn't in the current subscription tier.
    // We don't want to blow up — just return null and let downstream scorers
    // degrade to neutral. Same for any non-2xx.
    if (!res.ok) {
      cache.set(url, { data: null, at: Date.now() });
      return null;
    }
    const data = (await res.json()) as T;
    cache.set(url, { data, at: Date.now() });
    return data;
  } catch {
    cache.set(url, { data: null, at: Date.now() });
    return null;
  }
}

// Ticker-scoped fetch. Quiver sometimes returns an array, sometimes an object
// with a records field — we normalize to an array.
export async function quiverGetTicker<T = any>(
  endpoint: string,
  ticker: string,
  opts: { ttlMs?: number } = {},
): Promise<T[]> {
  const data = await quiverGet<T[] | { data?: T[]; records?: T[] }>(
    `/historical/${endpoint}/${encodeURIComponent(ticker)}`,
    opts,
  );
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const obj = data as any;
    if (Array.isArray(obj.data)) return obj.data;
    if (Array.isArray(obj.records)) return obj.records;
  }
  return [];
}

// Flexible field reader — Quiver's field names have shifted over the years
// (Date vs date, Ticker vs ticker, AcquiredDisposedCode vs ad_code). This
// helper tries each candidate until it finds one.
export function q(row: any, ...names: string[]): any {
  for (const n of names) {
    if (row && row[n] !== undefined && row[n] !== null && row[n] !== '') return row[n];
  }
  return undefined;
}

// Number coercion that treats strings, null, and undefined as "missing"
// rather than returning 0. Important for scoring — a missing field shouldn't
// contribute as a zero and skew weighted averages.
export function qn(row: any, ...names: string[]): number | undefined {
  const v = q(row, ...names);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

// ISO date coercion. Quiver returns dates in various forms (YYYY-MM-DD,
// ISO timestamps with offsets). We normalize to YYYY-MM-DD for comparison.
export function qdate(row: any, ...names: string[]): string {
  const v = q(row, ...names);
  if (!v) return '';
  const s = String(v);
  if (s.length >= 10 && /^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const d = new Date(s);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}
