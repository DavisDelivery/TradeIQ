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
import { getFinvizBucket } from './rate-limiter';

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
  /** PROFILE-1 W3 — screener column 4. The peer-pool level that actually
   *  means something: a margin ranked against "Technology" compares a
   *  software company with a contract manufacturer. */
  industry: string | null;
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
  /**
   * Average daily volume in THOUSANDS OF SHARES, as Finviz reports it — a
   * value of 56_434 means 56.4 MILLION shares.
   *
   * The unit is stated here because reading it as raw shares is a silent
   * 1000x error that looks entirely plausible. It shipped: `advDollar` was
   * derived as avgVolume x price, which put AAPL's average daily turnover at
   * $17.5M instead of $17.5B, and a $3M liquidity floor built on it excluded
   * 487 of 518 S&P/NDX/DJI names — Coca-Cola and Johnson & Johnson among them
   * — as "illiquid". Convert with `advDollar()` rather than multiplying here.
   */
  avgVolume: number | null;
  relVolume: number | null;
  price: number | null;
  changePct: number | null;
  volume: number | null;
  /** 'YYYY-MM-DD' — vendor opinion only; SEC 8-K remains authoritative. */
  earningsDate: string | null;
  earningsSession: 'amc' | 'bmo' | null;
  targetPrice: number | null;
  // FVZ-3 — screen-enabling columns.
  ps: number | null;
  pb: number | null;
  payoutRatioPct: number | null;
  epsGrowthPast5YPct: number | null;
  /** Free float in millions of shares. */
  floatM: number | null;
  insiderTransPct: number | null;
  /** Days to cover. */
  shortRatio: number | null;
  roaPct: number | null;
  roicPct: number | null;
  currentRatio: number | null;
  perfQuarterPct: number | null;
  beta: number | null;
  atr: number | null;
  // FVZ-5 — extended hours. Null outside the after-hours session.
  afterHoursClose: number | null;
  afterHoursChangePct: number | null;
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
  // PROFILE-1 W3. Header is byte-exact per the same 2026-08-03 enumeration
  // that verified the rest of this table; the id ordering corroborates it
  // (3 Sector, 4 Industry, 5 Country, 6 Market Cap).
  //
  // FAILURE MODE, checked before adding: `missingHeaders` is a WARNING, never
  // a throw (scan-screens.ts:77-79 pushes it into warnings; finviz-snapshot
  // reports it). So if Finviz's header text ever differs, `industry` goes
  // null everywhere and a schema-drift warning appears — the screens keep
  // scanning. That is the whole reason this was safe to add.
  { id: 4, header: 'Industry', field: 'industry', kind: 'text' },
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
  // FVZ-3 additions. Each one moves a published screen off a dedicated
  // Finviz call and onto the cached universe snapshot (free post-fetch):
  // P/S+P/B → small-cap value & Piotroski pre-filter; ROA/ROIC/current ratio
  // → Piotroski & Magic-Formula proxies; float+short ratio → squeeze screens;
  // perf quarter → the two-window momentum screens; beta+ATR → low-volatility.
  { id: 10, header: 'P/S', field: 'ps', kind: 'num' },
  { id: 11, header: 'P/B', field: 'pb', kind: 'num' },
  { id: 15, header: 'Payout Ratio', field: 'payoutRatioPct', kind: 'num' },
  { id: 19, header: 'EPS Growth Past 5 Years', field: 'epsGrowthPast5YPct', kind: 'num' },
  { id: 25, header: 'Shares Float', field: 'floatM', kind: 'num' },
  { id: 27, header: 'Insider Transactions', field: 'insiderTransPct', kind: 'num' },
  { id: 31, header: 'Short Ratio', field: 'shortRatio', kind: 'num' },
  { id: 32, header: 'Return on Assets', field: 'roaPct', kind: 'num' },
  { id: 34, header: 'Return on Invested Capital', field: 'roicPct', kind: 'num' },
  { id: 35, header: 'Current Ratio', field: 'currentRatio', kind: 'num' },
  { id: 44, header: 'Performance (Quarter)', field: 'perfQuarterPct', kind: 'num' },
  { id: 48, header: 'Beta', field: 'beta', kind: 'num' },
  { id: 49, header: 'Average True Range', field: 'atr', kind: 'num' },
  // FVZ-5 — extended-hours pricing. Confirmed live against the real token
  // (a c=0..99 header dump): 71 = After-Hours Close, 72 = After-Hours
  // Change. Nothing in the app had this before. It is what lets the PEAD
  // screen see an earnings reaction the EVENING it happens rather than
  // inferring it from week-over-week performance a day or more late —
  // which is the window Bernard & Thomas showed the drift starts from.
  { id: 71, header: 'After-Hours Close', field: 'afterHoursClose', kind: 'num' },
  { id: 72, header: 'After-Hours Change', field: 'afterHoursChangePct', kind: 'num' },
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
/**
 * Average daily turnover in DOLLARS from Finviz's thousands-of-shares column.
 *
 * Exists so the x1000 lives in exactly one place. Two independent call sites
 * each open-coded `avgVolume * price` and both were wrong by three orders of
 * magnitude; a third (`camillo-research.ts`) correctly renders the same field
 * as "{n}k", which is how the codebase came to disagree with itself about a
 * unit. Returns null unless both inputs are real — a liquidity figure guessed
 * from a missing input is worse than no figure.
 */
export function advDollar(
  avgVolumeThousands: number | null | undefined,
  price: number | null | undefined,
): number | null {
  if (!Number.isFinite(avgVolumeThousands as number)) return null;
  if (!Number.isFinite(price as number)) return null;
  return (avgVolumeThousands as number) * 1_000 * (price as number);
}

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
// Request core — one place that knows every way a Finviz call can fail
// ---------------------------------------------------------------------------

/**
 * Finviz throttles bursts and answers with HTTP 200 and a plain-text body
 * ("This user has performed an unusual high number of requests and has been
 * blocked..."), NOT 429. Measured 2026-08-03: ~25 rapid single-ticker calls
 * tripped it; it cleared inside a minute. Two consequences encoded below:
 *   1. Throttle is detected by BODY TEXT, since status and content-type lie.
 *   2. A trip arms a process-wide cooldown. The TREND-1 lesson applies with
 *      full force here — retrying into a throttle converts one blocked call
 *      into an amplification loop, and a Netlify container running a 500-name
 *      scan would otherwise keep firing for the whole invocation.
 */
const THROTTLE_MARKERS = ['unusual high number of requests', 'has been blocked'];
const THROTTLE_COOLDOWN_MS = 60_000;

let throttledUntil = 0;
export function __setFinvizThrottleForTesting(untilMs: number): void {
  throttledUntil = untilMs;
}
/** ms until the cooldown clears; 0 when not throttled. */
export function finvizThrottleRemainingMs(now = Date.now()): number {
  return Math.max(0, throttledUntil - now);
}

export function isFinvizThrottleBody(text: string): boolean {
  const head = text.slice(0, 400).toLowerCase();
  return THROTTLE_MARKERS.some((m) => head.includes(m));
}

export type FinvizFailReason =
  | 'disabled' // no token configured
  | 'throttled' // rate limited (or cooling down from a previous trip)
  | 'auth' // login page returned — token rejected/expired
  | 'http' // non-2xx
  | 'transport' // network error / timeout
  | 'empty'; // 2xx with no usable body

export type FinvizFetchOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: FinvizFailReason };

/**
 * Per-container failure tally by reason.
 *
 * The typed reason above existed from day one but NOTHING in production read
 * it — every call site collapsed the outcome to null, so an expired token
 * ("auth") was indistinguishable from a rate-limit ("throttled") or a
 * network blip. That matters most for `auth`: a rejected token silently
 * degrades every Finviz path back to Polygon at full cost, forever, with no
 * signal anywhere. Counting them here is the minimum that makes the
 * distinction observable.
 */
const failureCounts: Record<FinvizFailReason, number> = {
  disabled: 0,
  throttled: 0,
  auth: 0,
  http: 0,
  transport: 0,
  empty: 0,
};

function noteFinvizFailure(reason: FinvizFailReason): void {
  failureCounts[reason] += 1;
  if (reason === 'auth' && failureCounts.auth === 1) {
    // Once per container: loud, because it means the subscription or token
    // is broken and every board is quietly running on the fallback.
    console.error(
      '[finviz] auth rejected — Finviz returned its login page. Every Finviz ' +
        'path is now degrading to Polygon. Check FINVIZ_AUTH_TOKEN.',
    );
  }
}

export function finvizFailureCounts(): Record<FinvizFailReason, number> {
  return { ...failureCounts };
}

/** Warnings a scan can attach so a degraded Finviz is visible in snapshots. */
export function finvizFailureWarnings(): string[] {
  const out: string[] = [];
  if (failureCounts.auth > 0) {
    out.push(`finviz auth rejected ${failureCounts.auth}× — token expired or subscription lapsed`);
  }
  if (failureCounts.throttled > 0) {
    out.push(`finviz throttled ${failureCounts.throttled}× — results may be partial`);
  }
  return out;
}

export function __resetFinvizFailureCountsForTesting(): void {
  for (const k of Object.keys(failureCounts) as FinvizFailReason[]) failureCounts[k] = 0;
}

/**
 * Single entry point for every Finviz export path. Callers get a typed
 * failure reason instead of a bare null so telemetry can distinguish
 * "subscription lapsed" from "we hammered it" — they mean opposite things
 * and demand opposite responses.
 */
export async function finvizRequest(
  path: string,
  query: Record<string, string>,
): Promise<FinvizFetchOutcome> {
  const token = process.env.FINVIZ_AUTH_TOKEN;
  if (!token) return { ok: false, reason: 'disabled' };
  if (finvizThrottleRemainingMs() > 0) return { ok: false, reason: 'throttled' };

  // Pace before spending the call. The bucket is what stops a per-ticker loop
  // (bars, chains, insider history) from reproducing the burst that tripped
  // the limiter during endpoint discovery.
  await getFinvizBucket().acquire();

  const params = new URLSearchParams({ ...query, auth: token });
  let text: string;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`https://elite.finviz.com/export/${path}?${params}`, {
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (!res.ok) {
        // A real 429 counts as a throttle trip too.
        if (res.status === 429) throttledUntil = Date.now() + THROTTLE_COOLDOWN_MS;
        const reason: FinvizFailReason = res.status === 429 ? 'throttled' : 'http';
        noteFinvizFailure(reason);
        return { ok: false, reason };
      }
      text = await res.text();
    } finally {
      clearTimeout(timer);
    }
  } catch {
    noteFinvizFailure('transport');
    return { ok: false, reason: 'transport' };
  }

  if (isFinvizThrottleBody(text)) {
    throttledUntil = Date.now() + THROTTLE_COOLDOWN_MS;
    noteFinvizFailure('throttled');
    return { ok: false, reason: 'throttled' };
  }
  // Auth failures render the SPA/login page as HTML at HTTP 200.
  if (/^\s*<(!doctype|html)/i.test(text)) {
    noteFinvizFailure('auth');
    return { ok: false, reason: 'auth' };
  }
  if (text.trim() === '') return { ok: false, reason: 'empty' };
  return { ok: true, text };
}

// ---------------------------------------------------------------------------
// Screener
// ---------------------------------------------------------------------------

export interface FinvizScreenResult {
  rows: FinvizRow[];
  /** Headers requested but absent from the response (schema drift signal). */
  missingHeaders: string[];
}

/**
 * Finviz filters are ONE VALUE PER KEY, and a repeated key silently
 * LAST-WINS rather than AND-ing or erroring. Measured on the live screener:
 *
 *   ta_highlow52w_a30h                        -> 4378 results
 *   ta_highlow52w_b0to10h                     -> 5018
 *   ta_highlow52w_a30h,ta_highlow52w_b0to10h  -> 5018   (second only)
 *
 * So a screen that "adds a constraint" by repeating a family can silently
 * REPLACE the constraint it meant to tighten — and the result set still
 * looks plausible. That is a silent-corruption bug, so it fails loudly here
 * (screens are code, not user input; a throw is a build-time-ish error).
 *
 * Note the deliberate exception: `ta_perf` and `ta_perf2` are two
 * INDEPENDENT performance slots that do AND (verified: ta_perf_52w30o=2348,
 * ta_perf2_13w10o=1974, together=1020). They are distinct keys, so the
 * prefix rule below treats them correctly without special-casing.
 */
export function finvizFilterKey(filter: string): string {
  // Codes are `<family>_<value>`; the family is everything up to the LAST
  // underscore-delimited value token... except values themselves contain
  // underscores (ta_highlow52w_b0to10h). The stable rule is: the first two
  // underscore-separated segments identify the family (ta_highlow52w,
  // fa_pe, sh_avgvol, idx, cap, sec, exch).
  const parts = filter.split('_');
  return parts.length <= 1 ? filter : `${parts[0]}_${parts[1]}`;
}

export function assertNoDuplicateFilterKeys(filters: string[]): void {
  const seen = new Map<string, string>();
  for (const f of filters) {
    const key = finvizFilterKey(f);
    const prev = seen.get(key);
    if (prev !== undefined) {
      throw new Error(
        `finviz: duplicate filter family '${key}' ('${prev}' then '${f}'). ` +
          `Finviz silently last-wins on repeated keys, so this would DROP ` +
          `'${prev}' instead of AND-ing. Express the second constraint ` +
          `post-fetch, or use the ta_perf2 slot for a second performance window.`,
      );
    }
    seen.set(key, f);
  }
}

/**
 * Run a screener export. Pass `filters` (Finviz `f=` codes) and/or an
 * explicit `tickers` list (`t=`) — the ticker list accepts arbitrary symbols,
 * including names in no index (verified live: IONQ, PLTR, RKLB, SOFI), and
 * returned all 503 S&P names in ONE call at a ~2.1KB URL.
 *
 * Returns null on ANY failure shape (see finvizRequest) — including a body
 * that is not the expected CSV, since Finviz serves its login page at 200.
 */
export async function fetchFinvizScreener(
  filters: string[],
  tickers?: string[],
): Promise<FinvizScreenResult | null> {
  assertNoDuplicateFilterKeys(filters);
  const query: Record<string, string> = {
    v: '152',
    c: COLUMNS.map((c) => c.id).join(','),
  };
  if (filters.length > 0) query.f = filters.join(',');
  if (tickers && tickers.length > 0) query.t = tickers.map((t) => t.toUpperCase()).join(',');

  const out = await finvizRequest('screener', query);
  if (!out.ok) return null;
  const text = out.text;

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
 * Columnar wire format: the field-name list is stored ONCE in the manifest
 * and each row is a bare value array. Object-per-row would repeat 51 key
 * strings 1,954 times for the Russell 2000.
 *
 * earningsSession is derived from the 'earnings' column rather than being a
 * COLUMNS entry of its own, so both explicit fields are appended at the end.
 */
const CACHE_FIELDS: (keyof FinvizRow)[] = [
  ...(COLUMNS.map((c) => c.field).filter((f) => f !== 'earningsDate') as (keyof FinvizRow)[]),
  'earningsDate',
  'earningsSession',
];

/**
 * Cache epoch. Bumped to v2 when FVZ-3 widened COLUMNS from 36 to 51 and
 * switched to sharded storage — per the standing rule, a change that alters
 * cached VALUES must change the cache KEY, or containers keep serving
 * pre-change shapes for a full TTL.
 */
// v4: the Industry column (id 4) joined COLUMNS. The sharded universe cache
// stores rows POSITIONALLY against a field manifest, so a v3 shard written
// before the column existed would deserialise without `industry` and every
// peer pool would silently fall back to sector for up to 15 minutes. Bumping
// the epoch orphans the old shards instead.
const UNIVERSE_CACHE_EPOCH = 'v4';

/**
 * Rows per cache shard. Measured 2026-08-03: the russell2k columnar doc at
 * 51 columns × 1,954 rows serialized to 989KB — 94% of Firestore's 1MB
 * per-document ceiling, i.e. one index-reconstitution away from silently
 * failing every write. Sharding makes the bound structural instead of
 * lucky: 700 rows ≈ 350KB per shard regardless of how the index grows.
 */
const UNIVERSE_SHARD_ROWS = 700;

const universeManifestKey = (universe: FinvizUniverse) => ({
  provider: 'finviz',
  endpoint: 'screener-universe',
  ticker: `_${universe}`,
  extra: UNIVERSE_CACHE_EPOCH,
});

const universeShardKey = (universe: FinvizUniverse, i: number) => ({
  provider: 'finviz',
  endpoint: 'screener-universe-shard',
  ticker: `_${universe}#${i}`,
  extra: UNIVERSE_CACHE_EPOCH,
});

interface UniverseManifest {
  shards: number;
  f: string[];
  at: string;
  mh: string[];
}

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

  const cached = await readShardedUniverse(universe).catch(() => null);
  if (cached) return cached;

  const res = await fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS[universe]]);
  if (res === null) return null;

  const at = new Date().toISOString();
  await writeShardedUniverse(universe, res, at).catch(() => {});
  return { universe, rows: res.rows, fetchedAt: at, source: 'live', missingHeaders: res.missingHeaders };
}

async function readShardedUniverse(
  universe: FinvizUniverse,
): Promise<FinvizUniverseSnapshot | null> {
  const manifest = await liveCacheGet<UniverseManifest>(universeManifestKey(universe), (m) =>
    m && m.shards > 0 ? UNIVERSE_TTL_MS : UNIVERSE_EMPTY_TTL_MS,
  );
  if (!manifest || !Array.isArray(manifest.f) || typeof manifest.shards !== 'number') return null;

  const rows: FinvizRow[] = [];
  for (let i = 0; i < manifest.shards; i++) {
    const shard = await liveCacheGet<(string | number | null)[][]>(
      universeShardKey(universe, i),
      () => UNIVERSE_TTL_MS,
    );
    // A partial shard set is a MISS, not a short universe — serving 700 of
    // 1,954 names as if complete would silently truncate every screen.
    if (!Array.isArray(shard)) return null;
    for (const vals of shard) {
      const row = {} as Record<string, unknown>;
      manifest.f.forEach((field, fi) => {
        row[field] = vals[fi] ?? null;
      });
      rows.push(row as unknown as FinvizRow);
    }
  }
  return {
    universe,
    rows,
    fetchedAt: manifest.at,
    source: 'cache',
    missingHeaders: Array.isArray(manifest.mh) ? manifest.mh : [],
  };
}

async function writeShardedUniverse(
  universe: FinvizUniverse,
  res: FinvizScreenResult,
  at: string,
): Promise<void> {
  const encoded = res.rows.map((row) =>
    CACHE_FIELDS.map((f) => (row[f] === undefined ? null : row[f]) as string | number | null),
  );
  const shards: (string | number | null)[][][] = [];
  for (let i = 0; i < encoded.length; i += UNIVERSE_SHARD_ROWS) {
    shards.push(encoded.slice(i, i + UNIVERSE_SHARD_ROWS));
  }
  // Shards BEFORE manifest: the manifest is the commit point, so a crash
  // mid-write leaves orphan shards (harmless, TTL'd) rather than a manifest
  // promising shards that were never written (a permanent miss loop).
  for (let i = 0; i < shards.length; i++) {
    await liveCacheSet(universeShardKey(universe, i), shards[i]);
  }
  const manifest: UniverseManifest = {
    shards: shards.length,
    f: CACHE_FIELDS as string[],
    at,
    mh: res.missingHeaders,
  };
  await liveCacheSet(universeManifestKey(universe), manifest);
}

// ---------------------------------------------------------------------------
// Bars — /export/stock
// ---------------------------------------------------------------------------

/**
 * Timeframes probed live 2026-08-03 (AAPL):
 *   daily   — 2,522 rows back to 2016-07 (~10y), SPLIT-ADJUSTED (verified:
 *             pre-4:1-split Aug 2020 reads ~$126, not ~$505; NVDA pre-10:1
 *             reads ~$118, not ~$1,184)
 *   w / m   — same depth / back to 1984
 *   h       — ~10 months of hourly
 *   i5 / i1 — ~3 weeks / ~2 weeks of intraday
 *
 * KNOWN GAP: delisted and acquired tickers return ZERO rows (verified TWTR,
 * SIVB, FRC, ATVI, CREE, XLNX). Any backtest universe drawn from this source
 * is survivorship-biased by construction — callers doing historical work must
 * treat a 0-row answer as "no coverage", never as "no trading".
 */
export type FinvizTimeframe = 'd' | 'w' | 'm' | 'h' | 'i5' | 'i1';

export interface FinvizBar {
  /** 'YYYY-MM-DD' for d/w/m; 'YYYY-MM-DDTHH:mm' for intraday. */
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * '07/21/2016' | '07/20/2026 04:00 AM' | '08/03/2026 14:06' → ISO-ish key.
 *
 * Finviz mixes clock formats ACROSS endpoints: intraday bars use 12-hour with
 * a meridiem, Form-4 filing timestamps use bare 24-hour. Requiring AM/PM
 * silently nulled every insider filing time until a test caught it.
 */
export function parseFinvizBarDate(raw: string): string | null {
  const m = raw
    .trim()
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?)?$/i);
  if (!m) return null;
  const [, mo, day, yr, hh, mm, ampm] = m;
  const date = `${yr}-${mo.padStart(2, '0')}-${day.padStart(2, '0')}`;
  if (hh === undefined || mm === undefined) return date;
  let hour = Number(hh);
  if (ampm) {
    hour %= 12;
    if (ampm.toUpperCase() === 'PM') hour += 12;
  }
  if (hour > 23) return date;
  return `${date}T${String(hour).padStart(2, '0')}:${mm}`;
}

export function parseFinvizBars(text: string): FinvizBar[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  if (header[0] !== 'date' || !header.includes('close')) return [];
  const col = (name: string) => header.indexOf(name);
  const [oi, hi, li, ci, vi] = [col('open'), col('high'), col('low'), col('close'), col('volume')];

  const bars: FinvizBar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = parseCsvLine(lines[i]);
    const date = parseFinvizBarDate(cells[0] ?? '');
    if (!date) continue;
    const nums = [oi, hi, li, ci, vi].map((idx) => (idx < 0 ? null : parseFinvizNumber(cells[idx])));
    if (nums.some((n) => n === null)) continue;
    const [open, high, low, close, volume] = nums as number[];
    bars.push({ date, open, high, low, close, volume });
  }
  return bars;
}

/**
 * Split-adjusted OHLCV for one ticker. Returns null on any failure shape and
 * an EMPTY ARRAY for a valid-but-uncovered ticker (delisted) — the caller
 * must be able to tell "Finviz is down" from "Finviz never had this name".
 */
export async function fetchFinvizBars(
  ticker: string,
  timeframe: FinvizTimeframe = 'd',
): Promise<FinvizBar[] | null> {
  const query: Record<string, string> = { t: ticker.toUpperCase() };
  // Daily is the default and takes no `p`; the others are explicit.
  if (timeframe !== 'd') query.p = timeframe;
  const out = await finvizRequest('stock', query);
  if (!out.ok) return null;
  return parseFinvizBars(out.text);
}

// ---------------------------------------------------------------------------
// Insider transactions — /export/insiders
// ---------------------------------------------------------------------------

export interface FinvizInsiderTx {
  ticker: string;
  owner: string;
  ownerCik: string | null;
  relationship: string | null;
  /** Transaction date, 'YYYY-MM-DD'. */
  date: string | null;
  /** 'Buy' | 'Sale' | 'Option Exercise' | … as Finviz labels it. */
  transaction: string | null;
  price: number | null;
  shares: number | null;
  valueUsd: number | null;
  sharesTotal: number | null;
  /** SEC Form 4 filing timestamp — near-real-time; 'YYYY-MM-DDTHH:mm'. */
  filedAt: string | null;
  formUrl: string | null;
}

export function parseFinvizInsiders(text: string): FinvizInsiderTx[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const at = (name: string) => header.indexOf(name);
  if (at('Ticker') < 0 || at('Owner') < 0) return [];

  const idx = {
    ticker: at('Ticker'),
    owner: at('Owner'),
    cik: at('Owner CIK'),
    rel: at('Relationship'),
    date: at('Date'),
    tx: at('Transaction'),
    cost: at('Cost'),
    shares: at('#Shares'),
    value: at('Value ($)'),
    total: at('#Shares Total'),
    filed: at('SEC Form 4'),
    link: at('SEC Form 4 Link'),
  };
  const txt = (cells: string[], i: number) => {
    const v = (i < 0 ? '' : (cells[i] ?? '')).trim();
    return v === '' || v === '-' ? null : v;
  };

  const out: FinvizInsiderTx[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = parseCsvLine(lines[i]);
    const ticker = txt(c, idx.ticker);
    if (!ticker) continue;
    out.push({
      ticker,
      owner: txt(c, idx.owner) ?? '',
      ownerCik: txt(c, idx.cik),
      relationship: txt(c, idx.rel),
      date: parseFinvizBarDate(txt(c, idx.date) ?? ''),
      transaction: txt(c, idx.tx),
      price: parseFinvizNumber(c[idx.cost]),
      shares: parseFinvizNumber(c[idx.shares]),
      valueUsd: parseFinvizNumber(c[idx.value]),
      sharesTotal: parseFinvizNumber(c[idx.total]),
      filedAt: parseFinvizBarDate(txt(c, idx.filed) ?? ''),
      formUrl: txt(c, idx.link),
    });
  }
  return out;
}

/**
 * Insider Form-4 transactions. Omit `ticker` for the market-wide feed (the
 * 200 most recent filings across all names — measured live within minutes of
 * the SEC filing timestamp).
 */
export async function fetchFinvizInsiders(ticker?: string): Promise<FinvizInsiderTx[] | null> {
  const out = await finvizRequest('insiders', ticker ? { t: ticker.toUpperCase() } : {});
  if (!out.ok) return null;
  return parseFinvizInsiders(out.text);
}

// ---------------------------------------------------------------------------
// Option chain — /export/options
// ---------------------------------------------------------------------------

export interface FinvizOptionContract {
  contract: string;
  expiry: string | null;
  strike: number | null;
  type: 'call' | 'put' | null;
  lastClose: number | null;
  bid: number | null;
  ask: number | null;
  changePct: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
}

export function parseFinvizOptions(text: string): FinvizOptionContract[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const at = (n: string) => header.indexOf(n);
  if (at('Contract Name') < 0) return [];

  const i = {
    contract: at('Contract Name'),
    expiry: at('Expiry'),
    strike: at('Strike'),
    close: at('Last Close'),
    bid: at('Bid'),
    ask: at('Ask'),
    chg: at('Change %'),
    vol: at('Volume'),
    oi: at('Open Int.'),
    type: at('Type'),
    iv: at('IV'),
    delta: at('Delta'),
    gamma: at('Gamma'),
    theta: at('Theta'),
    vega: at('Vega'),
    rho: at('Rho'),
  };

  const out: FinvizOptionContract[] = [];
  for (let li = 1; li < lines.length; li++) {
    const c = parseCsvLine(lines[li]);
    const contract = (c[i.contract] ?? '').trim();
    if (!contract) continue;
    const rawType = (i.type < 0 ? '' : (c[i.type] ?? '')).trim().toLowerCase();
    out.push({
      contract,
      expiry: parseFinvizBarDate(((i.expiry < 0 ? '' : c[i.expiry]) ?? '').trim()),
      strike: parseFinvizNumber(c[i.strike]),
      type: rawType.startsWith('call') ? 'call' : rawType.startsWith('put') ? 'put' : null,
      lastClose: parseFinvizNumber(c[i.close]),
      bid: parseFinvizNumber(c[i.bid]),
      ask: parseFinvizNumber(c[i.ask]),
      changePct: parseFinvizNumber(c[i.chg]),
      volume: parseFinvizNumber(c[i.vol]),
      openInterest: parseFinvizNumber(c[i.oi]),
      iv: parseFinvizNumber(c[i.iv]),
      delta: parseFinvizNumber(c[i.delta]),
      gamma: parseFinvizNumber(c[i.gamma]),
      theta: parseFinvizNumber(c[i.theta]),
      vega: parseFinvizNumber(c[i.vega]),
      rho: parseFinvizNumber(c[i.rho]),
    });
  }
  return out;
}

/** Full option chain WITH greeks (measured: 3,646 AAPL contracts in one call). */
export async function fetchFinvizOptionChain(
  ticker: string,
): Promise<FinvizOptionContract[] | null> {
  const out = await finvizRequest('options', { t: ticker.toUpperCase() });
  if (!out.ok) return null;
  return parseFinvizOptions(out.text);
}

// ---------------------------------------------------------------------------
// SEC filings — /export/latest-filings
// ---------------------------------------------------------------------------

export interface FinvizFiling {
  filingDate: string | null;
  reportDate: string | null;
  form: string | null;
  description: string | null;
  filingUrl: string | null;
  documentUrl: string | null;
}

export function parseFinvizFilings(text: string): FinvizFiling[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const at = (n: string) => header.indexOf(n);
  if (at('Filing Date') < 0 || at('Form') < 0) return [];
  const txt = (c: string[], i: number) => {
    const v = (i < 0 ? '' : (c[i] ?? '')).trim();
    return v === '' || v === '-' ? null : v;
  };

  const out: FinvizFiling[] = [];
  for (let li = 1; li < lines.length; li++) {
    const c = parseCsvLine(lines[li]);
    const form = txt(c, at('Form'));
    if (!form) continue;
    out.push({
      filingDate: parseFinvizBarDate(txt(c, at('Filing Date')) ?? ''),
      reportDate: parseFinvizBarDate(txt(c, at('Report Date')) ?? ''),
      form,
      description: txt(c, at('Description')),
      filingUrl: txt(c, at('Filing')),
      documentUrl: txt(c, at('Document')),
    });
  }
  return out;
}

/**
 * Per-ticker SEC filings with direct EDGAR links. Convenience only — our own
 * EDGAR path stays authoritative for 8-K Item 2.02 announcement dates.
 */
export async function fetchFinvizFilings(ticker: string): Promise<FinvizFiling[] | null> {
  const out = await finvizRequest('latest-filings', { t: ticker.toUpperCase() });
  if (!out.ok) return null;
  return parseFinvizFilings(out.text);
}

// ---------------------------------------------------------------------------
// 13F manager / fund summaries — /export/managers, /export/funds
// ---------------------------------------------------------------------------

export interface FinvizManager {
  name: string;
  portfolioManager: string | null;
  investorId: string | null;
  reportDate: string | null;
  portfolioValueUsd: number | null;
  investments: number | null;
  newPurchased: number | null;
  soldOut: number | null;
  added: number | null;
  reduced: number | null;
  top10ConcentrationPct: number | null;
  turnoverPct: number | null;
}

export function parseFinvizManagers(text: string): FinvizManager[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) return [];
  const header = parseCsvLine(lines[0]);
  const at = (n: string) => header.indexOf(n);
  if (at('Name') < 0 || at('Investor ID') < 0) return [];
  const txt = (c: string[], i: number) => {
    const v = (i < 0 ? '' : (c[i] ?? '')).trim();
    return v === '' || v === '-' ? null : v;
  };

  const out: FinvizManager[] = [];
  for (let li = 1; li < lines.length; li++) {
    const c = parseCsvLine(lines[li]);
    const name = txt(c, at('Name'));
    if (!name) continue;
    out.push({
      name,
      portfolioManager: txt(c, at('Portfolio Manager')),
      investorId: txt(c, at('Investor ID')),
      reportDate: txt(c, at('Report Date')),
      portfolioValueUsd: parseFinvizNumber(c[at('Portfolio Value')]),
      investments: parseFinvizNumber(c[at('# Investments')]),
      newPurchased: parseFinvizNumber(c[at('New Purchased')]),
      soldOut: parseFinvizNumber(c[at('Sold Out')]),
      added: parseFinvizNumber(c[at('Added')]),
      reduced: parseFinvizNumber(c[at('Reduced')]),
      top10ConcentrationPct: parseFinvizNumber(c[at('Top 10 Concentration (%)')]),
      turnoverPct: parseFinvizNumber(c[at('Turnover (%)')]),
    });
  }
  return out;
}

/**
 * 13F filer summaries (top ~500). `investorId` narrows to one filer.
 * Position-level holdings are NOT exposed by this endpoint — our EDGAR 13F
 * ingest remains the source for actual positions.
 */
export async function fetchFinvizManagers(investorId?: string): Promise<FinvizManager[] | null> {
  const out = await finvizRequest('managers', investorId ? { id: investorId } : {});
  if (!out.ok) return null;
  return parseFinvizManagers(out.text);
}

/** Same shape as managers, for fund series. */
export async function fetchFinvizFunds(investorId?: string): Promise<FinvizManager[] | null> {
  const out = await finvizRequest('funds', investorId ? { id: investorId } : {});
  if (!out.ok) return null;
  return parseFinvizManagers(out.text);
}

// ---------------------------------------------------------------------------
// Batched quotes
// ---------------------------------------------------------------------------

export interface FinvizQuote {
  ticker: string;
  price: number | null;
  changePct: number | null;
  volume: number | null;
}

/**
 * Live price + intraday %-change for an arbitrary ticker list.
 *
 * Measured: 503 symbols answered in ONE call (Polygon's snapshot caps at 100
 * per call, so /api/quotes chunks 300 tickers into 3). Elite quotes are
 * real-time. Chunked at 400 here purely to keep the URL comfortably inside
 * proxy/CDN limits — 503 tickers was already ~2.1KB of query string.
 *
 * Returns null if EVERY chunk failed, so callers can tell a dead upstream
 * from a genuinely unknown symbol.
 */
export async function fetchFinvizQuotes(tickers: string[]): Promise<FinvizQuote[] | null> {
  const unique = [...new Set(tickers.map((t) => t.toUpperCase()).filter(Boolean))];
  if (unique.length === 0) return [];

  const CHUNK = 400;
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK));

  const quotes: FinvizQuote[] = [];
  let anyOk = false;
  for (const chunk of chunks) {
    const out = await finvizRequest('screener', {
      v: '152',
      t: chunk.join(','),
      c: '1,65,66,67', // Ticker, Price, Change, Volume
    });
    if (!out.ok) continue;
    const lines = out.text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    const header = parseCsvLine(lines[0]);
    const ti = header.indexOf('Ticker');
    if (ti < 0) continue;
    anyOk = true;
    const pi = header.indexOf('Price');
    const ci = header.indexOf('Change');
    const vi = header.indexOf('Volume');
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCsvLine(lines[i]);
      const ticker = (cells[ti] ?? '').trim();
      if (!ticker) continue;
      quotes.push({
        ticker,
        price: parseFinvizNumber(cells[pi]),
        changePct: parseFinvizNumber(cells[ci]),
        volume: parseFinvizNumber(cells[vi]),
      });
    }
  }
  return anyOk ? quotes : null;
}
