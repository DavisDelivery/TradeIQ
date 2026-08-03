// Finviz Elite export client (FVZ-1, 2026-08-03).
//
// Why this exists: every board scan today assembles its universe picture
// from hundreds of per-ticker provider calls paced through shared token
// buckets (Finnhub 55rpm being the chronic bottleneck — see the 2026-07-15
// and 2026-08-03 staleness incidents). Finviz Elite's export API returns an
// ENTIRE index universe with ~36 fundamental + technical columns in ONE
// HTTP call (~130KB for the S&P 500, ~475KB for the Russell 2000, measured
// 2026-08-03). That makes it a cheap, real-time pre-filter layer in front
// of the expensive per-ticker pipelines — NOT a replacement for them:
// Finviz has no price history (Polygon) and no statement history (Massive),
// and its values are current-snapshot only, so nothing here may ever feed
// a PIT/backtest path.
//
// Transport facts (probed live against the real account):
//   - GET https://elite.finviz.com/export/screener?v=152&f=<filters>&c=<ids>&auth=<token>
//   - Plain CSV, header row, no pagination. Column IDs 0-90 are contiguous
//     and positional, but we parse BY HEADER NAME so a Finviz-side reshuffle
//     degrades to missing fields (visible in warnings), never to silently
//     transposed values.
//   - Auth failures / bad paths return the login page as HTML **with HTTP
//     200** — body shape, not status, is the success signal.
//
// Cache discipline (M8 / 4t-W1c): one durable Firestore entry per universe,
// 15-minute TTL. A verified-empty answer (valid CSV header, zero rows)
// caches for a short window; a FAILED call (HTTP !ok, HTML body, transport
// throw, missing token) is returned as null and NEVER cached.

import { liveCacheGet, liveCacheSet } from './provider-live-cache';

export const FINVIZ_EXPORT_BASE = 'https://elite.finviz.com/export/screener';

export type FinvizUniverse = 'sp500' | 'russell2k' | 'ndx' | 'dji';

/** Finviz screener filter code per universe (probed: row counts 503 / 1954 / 103 / 30). */
export const FINVIZ_UNIVERSE_FILTERS: Record<FinvizUniverse, string> = {
  sp500: 'idx_sp500',
  russell2k: 'idx_rut',
  ndx: 'idx_ndx',
  dji: 'idx_dji',
};

export interface FinvizRow {
  ticker: string;
  sector: string | null;
  /** Millions of USD, as Finviz reports it. */
  marketCapM: number | null;
  pe: number | null;
  forwardPe: number | null;
  peg: number | null;
  dividendYieldPct: number | null;
  epsGrowthThisYearPct: number | null;
  epsGrowthNextYearPct: number | null;
  epsGrowthNext5YPct: number | null;
  epsGrowthQoQPct: number | null;
  salesGrowthQoQPct: number | null;
  insiderOwnPct: number | null;
  instOwnPct: number | null;
  shortFloatPct: number | null;
  roePct: number | null;
  debtToEquity: number | null;
  grossMarginPct: number | null;
  profitMarginPct: number | null;
  perfWeekPct: number | null;
  perfMonthPct: number | null;
  perfYearPct: number | null;
  /** Price distance from the SMA, percent (Finviz convention: +5% = 5% above). */
  sma20DistPct: number | null;
  sma50DistPct: number | null;
  sma200DistPct: number | null;
  /** Distance from 52w high (negative = below) / low (positive = above). */
  high52wDistPct: number | null;
  low52wDistPct: number | null;
  rsi14: number | null;
  /** 1.0 = strong buy … 5.0 = strong sell. */
  analystRecom: number | null;
  avgVolume: number | null;
  relVolume: number | null;
  price: number | null;
  changePct: number | null;
  volume: number | null;
  /** 'YYYY-MM-DD' — vendor opinion only; SEC 8-K remains authoritative. */
  earningsDate: string | null;
  earningsSession: 'amc' | 'bmo' | null;
  targetPrice: number | null;
}

interface ColumnSpec {
  /** Finviz export column ID (the `c=` parameter). */
  id: number;
  /** Exact CSV header Finviz emits for this column. */
  header: string;
  field: keyof FinvizRow;
  kind: 'text' | 'num' | 'earnings';
}

// Verified against the live export 2026-08-03 (IDs 0-90 enumerated by range
// counting; headers below are byte-exact). `earningsDate`/`earningsSession`
// both derive from the single "Earnings Date" column.
const COLUMNS: ColumnSpec[] = [
  { id: 1, header: 'Ticker', field: 'ticker', kind: 'text' },
  { id: 3, header: 'Sector', field: 'sector', kind: 'text' },
  { id: 6, header: 'Market Cap', field: 'marketCapM', kind: 'num' },
  { id: 7, header: 'P/E', field: 'pe', kind: 'num' },
  { id: 8, header: 'Forward P/E', field: 'forwardPe', kind: 'num' },
  { id: 9, header: 'PEG', field: 'peg', kind: 'num' },
  { id: 14, header: 'Dividend Yield', field: 'dividendYieldPct', kind: 'num' },
  { id: 17, header: 'EPS Growth This Year', field: 'epsGrowthThisYearPct', kind: 'num' },
  { id: 18, header: 'EPS Growth Next Year', field: 'epsGrowthNextYearPct', kind: 'num' },
  { id: 20, header: 'EPS Growth Next 5 Years', field: 'epsGrowthNext5YPct', kind: 'num' },
  { id: 22, header: 'EPS Growth Quarter Over Quarter', field: 'epsGrowthQoQPct', kind: 'num' },
  { id: 23, header: 'Sales Growth Quarter Over Quarter', field: 'salesGrowthQoQPct', kind: 'num' },
  { id: 26, header: 'Insider Ownership', field: 'insiderOwnPct', kind: 'num' },
  { id: 28, header: 'Institutional Ownership', field: 'instOwnPct', kind: 'num' },
  { id: 30, header: 'Short Float', field: 'shortFloatPct', kind: 'num' },
  { id: 33, header: 'Return on Equity', field: 'roePct', kind: 'num' },
  { id: 38, header: 'Total Debt/Equity', field: 'debtToEquity', kind: 'num' },
  { id: 39, header: 'Gross Margin', field: 'grossMarginPct', kind: 'num' },
  { id: 41, header: 'Profit Margin', field: 'profitMarginPct', kind: 'num' },
  { id: 42, header: 'Performance (Week)', field: 'perfWeekPct', kind: 'num' },
  { id: 43, header: 'Performance (Month)', field: 'perfMonthPct', kind: 'num' },
  { id: 46, header: 'Performance (Year)', field: 'perfYearPct', kind: 'num' },
  { id: 52, header: '20-Day Simple Moving Average', field: 'sma20DistPct', kind: 'num' },
  { id: 53, header: '50-Day Simple Moving Average', field: 'sma50DistPct', kind: 'num' },
  { id: 54, header: '200-Day Simple Moving Average', field: 'sma200DistPct', kind: 'num' },
  { id: 57, header: '52-Week High', field: 'high52wDistPct', kind: 'num' },
  { id: 58, header: '52-Week Low', field: 'low52wDistPct', kind: 'num' },
  { id: 59, header: 'Relative Strength Index (14)', field: 'rsi14', kind: 'num' },
  { id: 62, header: 'Analyst Recom', field: 'analystRecom', kind: 'num' },
  { id: 63, header: 'Average Volume', field: 'avgVolume', kind: 'num' },
  { id: 64, header: 'Relative Volume', field: 'relVolume', kind: 'num' },
  { id: 65, header: 'Price', field: 'price', kind: 'num' },
  { id: 66, header: 'Change', field: 'changePct', kind: 'num' },
  { id: 67, header: 'Volume', field: 'volume', kind: 'num' },
  { id: 68, header: 'Earnings Date', field: 'earningsDate', kind: 'earnings' },
  { id: 69, header: 'Target Price', field: 'targetPrice', kind: 'num' },
];

const REQUEST_TIMEOUT_MS = 20_000;
const UNIVERSE_TTL_MS = 15 * 60_000;
const UNIVERSE_EMPTY_TTL_MS = 5 * 60_000;

export function finvizEnabled(): boolean {
  return Boolean(process.env.FINVIZ_AUTH_TOKEN);
}

// ---------------------------------------------------------------------------
// CSV parsing (quote-aware: sector/company values contain commas)
// ---------------------------------------------------------------------------

export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** '', '-' → null; strips %, thousands commas. */
export function parseFinvizNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const t = raw.trim();
  if (t === '' || t === '-') return null;
  const n = Number(t.replace(/,/g, '').replace(/%$/, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * "7/30/2026 4:30:00 PM" → { date: '2026-07-30', session: 'amc' }.
 * Time ≥ 16:00 ET = after close (amc); < 09:30 ET = before open (bmo);
 * date-only or intraday times → session null.
 */
export function parseFinvizEarnings(
  raw: string | undefined,
): { date: string | null; session: 'amc' | 'bmo' | null } {
  const t = (raw ?? '').trim();
  if (t === '' || t === '-') return { date: null, session: null };
  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM))?/i);
  if (!m) return { date: null, session: null };
  const [, mo, day, yr, hh, mm, ampm] = m;
  const date = `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (!hh || !ampm) return { date, session: null };
  let hour = Number(hh) % 12;
  if (ampm.toUpperCase() === 'PM') hour += 12;
  const minutes = hour * 60 + Number(mm);
  if (minutes >= 16 * 60) return { date, session: 'amc' };
  if (minutes < 9 * 60 + 30) return { date, session: 'bmo' };
  return { date, session: null };
}

// ---------------------------------------------------------------------------
// Fetch + parse
// ---------------------------------------------------------------------------

export interface FinvizScreenResult {
  rows: FinvizRow[];
  /** Headers requested but absent from the response (schema drift signal). */
  missingHeaders: string[];
}

/**
 * Run a screener export for a set of Finviz filter codes. Returns null on
 * ANY failure shape: missing token, transport error, HTTP !ok, or a body
 * that is not the expected CSV (Finviz serves its login page as HTML with
 * HTTP 200 on auth problems — status alone proves nothing).
 */
export async function fetchFinvizScreener(filters: string[]): Promise<FinvizScreenResult | null> {
  const token = process.env.FINVIZ_AUTH_TOKEN;
  if (!token) return null;

  const params = new URLSearchParams({
    v: '152',
    f: filters.join(','),
    c: COLUMNS.map((c) => c.id).join(','),
    auth: token,
  });

  let text: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${FINVIZ_EXPORT_BASE}?${params}`, {
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return null;
  }

  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const headers = parseCsvLine(lines[0]);
  // Body-shape auth check: the login page is HTML, whose "header row" can
  // never contain a Ticker column.
  if (!headers.includes('Ticker')) return null;

  const idx = new Map<string, number>();
  headers.forEach((h, i) => idx.set(h, i));
  const missingHeaders = COLUMNS.filter((c) => !idx.has(c.header)).map((c) => c.header);

  const rows: FinvizRow[] = [];
  for (let li = 1; li < lines.length; li++) {
    const cells = parseCsvLine(lines[li]);
    const row = {} as Record<keyof FinvizRow, unknown>;
    for (const col of COLUMNS) {
      const pos = idx.get(col.header);
      const raw = pos === undefined ? undefined : cells[pos];
      if (col.kind === 'text') {
        const t = (raw ?? '').trim();
        row[col.field] = t === '' || t === '-' ? null : t;
      } else if (col.kind === 'num') {
        row[col.field] = parseFinvizNumber(raw);
      } else {
        const { date, session } = parseFinvizEarnings(raw);
        row.earningsDate = date;
        row.earningsSession = session;
      }
    }
    const typed = row as unknown as FinvizRow;
    if (typed.ticker) rows.push(typed);
  }
  return { rows, missingHeaders };
}

// ---------------------------------------------------------------------------
// Durable universe snapshot (one Firestore doc per universe, columnar)
// ---------------------------------------------------------------------------

export interface FinvizUniverseSnapshot {
  universe: FinvizUniverse;
  rows: FinvizRow[];
  fetchedAt: string; // ISO
  source: 'cache' | 'live';
  missingHeaders: string[];
}

/**
 * Columnar wire format for the cache doc: field-name list once + value
 * arrays per row. At ~1954 Russell 2000 rows the object-per-row encoding
 * would repeat 38 key strings per row — columnar keeps the doc well under
 * Firestore's 1MB ceiling (measured ~400KB).
 */
interface CachedUniverse {
  f: string[];
  r: (string | number | null)[][];
  at: string;
  mh: string[];
}

// earningsSession is derived from the 'earnings' column, not a COLUMNS
// entry of its own — append both explicit fields at the end.
const CACHE_FIELDS: (keyof FinvizRow)[] = [
  ...(COLUMNS.map((c) => c.field).filter((f) => f !== 'earningsDate') as (keyof FinvizRow)[]),
  'earningsDate',
  'earningsSession',
];

function toColumnar(res: FinvizScreenResult, at: string): CachedUniverse {
  return {
    f: CACHE_FIELDS as string[],
    r: res.rows.map((row) => CACHE_FIELDS.map((f) => (row[f] === undefined ? null : row[f]) as string | number | null)),
    at,
    mh: res.missingHeaders,
  };
}

function fromColumnar(c: CachedUniverse): { rows: FinvizRow[]; at: string; mh: string[] } | null {
  if (!c || !Array.isArray(c.f) || !Array.isArray(c.r) || typeof c.at !== 'string') return null;
  const rows = c.r.map((vals) => {
    const row = {} as Record<string, unknown>;
    c.f.forEach((field, i) => {
      row[field] = vals[i] ?? null;
    });
    return row as unknown as FinvizRow;
  });
  return { rows, at: c.at, mh: Array.isArray(c.mh) ? c.mh : [] };
}

const universeCacheKey = (universe: FinvizUniverse) => ({
  provider: 'finviz',
  endpoint: 'screener-universe',
  ticker: `_${universe}`,
  extra: 'v1',
});

/**
 * Universe snapshot with the durable-cache discipline: a fresh cache hit
 * costs zero upstream calls; a live fetch (success OR verified-empty) is
 * persisted; a failure is returned as null and never persisted, so a
 * Finviz outage can't masquerade as an empty index for the next 15 min.
 */
export async function getFinvizUniverseSnapshot(
  universe: FinvizUniverse,
): Promise<FinvizUniverseSnapshot | null> {
  if (!finvizEnabled()) return null;
  const key = universeCacheKey(universe);

  const hit = await liveCacheGet<CachedUniverse>(key, (v) =>
    v && Array.isArray(v.r) && v.r.length > 0 ? UNIVERSE_TTL_MS : UNIVERSE_EMPTY_TTL_MS,
  ).catch(() => null);
  if (hit) {
    const decoded = fromColumnar(hit);
    if (decoded) {
      return { universe, rows: decoded.rows, fetchedAt: decoded.at, source: 'cache', missingHeaders: decoded.mh };
    }
  }

  const res = await fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS[universe]]);
  if (res === null) return null;

  const at = new Date().toISOString();
  await liveCacheSet(key, toColumnar(res, at)).catch(() => {});
  return { universe, rows: res.rows, fetchedAt: at, source: 'live', missingHeaders: res.missingHeaders };
}
