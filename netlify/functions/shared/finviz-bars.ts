// FVZ-4 — Finviz as the primary daily-bar source.
//
// WHY: bars are far and away our heaviest upstream cost. One prophet
// russell2k sieve issues ~2,037 `getDailyBars` calls at concurrency 20
// (~17 req/s sustained, uncached) and there are ~180 full-universe scans a
// weekday. Polygon serves those today with no rate limiter at all.
//
// THE STRUCTURAL WIN ISN'T THE VENDOR, IT'S THE SHAPE OF THE REQUEST.
// Polygon's aggregates endpoint is range-parameterised, so every distinct
// (ticker, from, to) is a separate call — and our scans ask for 120d, 320d,
// 400d, 460d, 560d, 680d and 2200d windows over overlapping universes, so
// the SAME ticker is refetched five or six times a day at different widths.
// Finviz's /export/stock takes no range at all: it returns the whole ~10y
// history every time. That turns the range into a SLICE of one cached
// payload — first caller for a ticker pays one request, every window after
// that is free until the daily TTL rolls.
//
// ACCURACY (measured 2026-08-03, not assumed): Finviz vs Polygon daily
// closes for AAPL across all 252 trading days of 2024 matched to 0.00000%.
// Bars are split-adjusted (pre-4:1 AAPL reads ~$126, not ~$505). Volume
// differs by up to ~5% on some days — consolidated-tape late prints — so
// volume-sensitive logic should treat it as approximate.
//
// COVERAGE GAP, DELIBERATE AND VISIBLE: delisted/acquired tickers return
// ZERO rows (verified TWTR, SIVB, FRC, ATVI, CREE, XLNX). That is why this
// module returns null for "no coverage" and lets the caller fall back to
// Polygon rather than silently reporting a name as untradeable. With
// Polygon absent the name simply drops out — which is survivorship bias,
// and `barsCoverageGaps()` exists so a backtest can SAY so instead of
// quietly presenting a survivor-only result as complete.

import { fetchFinvizBars, finvizEnabled, type FinvizBar } from './finviz';
import { liveCacheGet, liveCacheSet } from './provider-live-cache';

export interface Bar {
  t: number; // ms epoch, UTC midnight of the session date
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * Daily bars only revise for splits, and a split is announced days ahead,
 * so a ~20h shelf life is safe and lands every scan of a given day on one
 * fetch. Deliberately shorter than 24h so a container running at the same
 * clock time each day still re-reads rather than pinning stale history.
 */
const BARS_TTL_MS = 20 * 60 * 60_000;
/** A covered-but-empty answer is re-verified much sooner. */
const BARS_EMPTY_TTL_MS = 2 * 60 * 60_000;

const CACHE_EPOCH = 'v1';

export function finvizBarsEnabled(): boolean {
  if (!finvizEnabled()) return false;
  // Escape hatch: FINVIZ_BARS=off pins every caller back to Polygon without
  // a deploy, in case the vendor regresses.
  return (process.env.FINVIZ_BARS ?? 'on').toLowerCase() !== 'off';
}

// ---------------------------------------------------------------------------
// Coverage telemetry
// ---------------------------------------------------------------------------

const coverageGaps = new Set<string>();
const depthShortfalls = new Set<string>();

/**
 * Tickers this container asked Finviz for and got no coverage on. A scan or
 * backtest attaches this to its warnings so a survivor-only run is
 * self-declaring rather than silently short — see `finvizBarsWarnings()`,
 * which is what production actually calls.
 */
export function barsCoverageGaps(): string[] {
  return [...coverageGaps].sort();
}

/** Tickers whose requested window reached back past Finviz's retention. */
export function barsDepthShortfalls(): string[] {
  return [...depthShortfalls].sort();
}

/**
 * Human-readable warnings for the current run, or [] when nothing notable
 * happened. This is the piece the first version was missing: the sets above
 * were populated but nothing ever read them, so the "survivorship is
 * declared, not hidden" promise in this file's header was unimplemented.
 *
 * Coverage gaps are the load-bearing one. With Polygon deconfigured a
 * delisted name silently vanishes from a backtest universe, which is
 * survivorship bias — the owner has accepted that trade, but accepting it
 * is not the same as being unable to see it.
 */
export function finvizBarsWarnings(): string[] {
  const out: string[] = [];
  const gaps = barsCoverageGaps();
  if (gaps.length > 0) {
    out.push(
      `finviz bar coverage gap: ${gaps.length} ticker(s) had no history ` +
        `(${gaps.slice(0, 8).join(', ')}${gaps.length > 8 ? ', …' : ''}) — ` +
        `if Polygon did not backfill them, results are survivor-only`,
    );
  }
  const short = barsDepthShortfalls();
  if (short.length > 0) {
    out.push(
      `finviz history depth shortfall: ${short.length} ticker(s) needed bars ` +
        `older than Finviz retains (${short.slice(0, 8).join(', ')}` +
        `${short.length > 8 ? ', …' : ''}) — served from Polygon instead`,
    );
  }
  return out;
}

/** Reset per-run counters. Call at scan/backtest entry, not per ticker. */
export function resetFinvizBarsTelemetry(): void {
  coverageGaps.clear();
  depthShortfalls.clear();
}
export function __resetBarsCoverageForTesting(): void {
  resetFinvizBarsTelemetry();
}

// ---------------------------------------------------------------------------
// Cache: one full-history document per ticker, sliced per request
// ---------------------------------------------------------------------------

const barsKey = (ticker: string) => ({
  provider: 'finviz',
  endpoint: 'stock-daily',
  ticker: ticker.toUpperCase(),
  extra: CACHE_EPOCH,
});

/** Columnar: dates and five parallel numeric arrays. ~2,500 sessions/ticker. */
interface CachedBars {
  d: string[]; // 'YYYY-MM-DD'
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
}

function encode(bars: FinvizBar[]): CachedBars {
  return {
    d: bars.map((b) => b.date),
    o: bars.map((b) => b.open),
    h: bars.map((b) => b.high),
    l: bars.map((b) => b.low),
    c: bars.map((b) => b.close),
    v: bars.map((b) => b.volume),
  };
}

function isCachedBars(v: unknown): v is CachedBars {
  const c = v as CachedBars;
  return Boolean(c && Array.isArray(c.d) && Array.isArray(c.c) && c.d.length === c.c.length);
}

/** Session date → ms epoch at UTC midnight, matching Polygon's convention. */
export function sessionDateToMs(date: string): number {
  return Date.parse(`${date}T00:00:00Z`);
}

/**
 * Slice a cached history to [from, to] inclusive. Dates are ISO and the
 * source is sorted ascending, so plain string comparison is correct and
 * avoids parsing ~2,500 dates per call.
 */
export function sliceBars(cached: CachedBars, from: string, to: string): Bar[] {
  const out: Bar[] = [];
  for (let i = 0; i < cached.d.length; i++) {
    const d = cached.d[i];
    if (d < from) continue;
    if (d > to) break;
    out.push({
      t: sessionDateToMs(d),
      o: cached.o[i],
      h: cached.h[i],
      l: cached.l[i],
      c: cached.c[i],
      v: cached.v[i],
    });
  }
  return out;
}

/**
 * Daily bars for [from, to] from Finviz.
 *
 * Returns null for "the call failed", "Finviz has no coverage for this
 * ticker", AND — critically — "the requested window starts before Finviz's
 * retention". In every one of those cases the caller must try Polygon.
 *
 * THE DEPTH TRAP (audit 2026-08-04). Finviz's /export/stock carries only
 * ~10y (~2,500 sessions) and `sliceBars` silently clips to whatever is
 * cached. The first version of this function returned that clipped slice,
 * and `getDailyBars` short-circuits on any non-null answer — so a request
 * for 2000→today came back starting in 2016 with NOTHING indicating it had
 * been truncated, and Polygon (which has the rest) was never asked. Worse,
 * PIT callers wrap this in `pitCacheWrap`, which has no TTL by design, so a
 * truncated series would have been cached permanently and silently shortened
 * every backtest that touched it.
 *
 * The rule: only trust an in-range answer. If `from` precedes the earliest
 * session we hold, we cannot know what Finviz is missing, so we decline and
 * let Polygon serve the whole window from one consistent source.
 *
 * Returns an empty array only when the ticker IS covered, the window lies
 * INSIDE the covered range, and there genuinely are no sessions in it.
 */
export async function getFinvizDailyBars(
  ticker: string,
  from: string,
  to: string,
): Promise<Bar[] | null> {
  if (!finvizBarsEnabled()) return null;
  const key = barsKey(ticker);

  const hit = await liveCacheGet<CachedBars>(key, (v) =>
    isCachedBars(v) && v.d.length > 0 ? BARS_TTL_MS : BARS_EMPTY_TTL_MS,
  ).catch(() => null);
  if (isCachedBars(hit)) {
    if (hit.d.length === 0) return null; // cached "no coverage"
    return sliceWithinCoverage(hit, ticker, from, to);
  }

  const fetched = await fetchFinvizBars(ticker, 'd');
  if (fetched === null) return null; // transport/throttle/auth — never cached

  if (fetched.length === 0) {
    // Covered-but-empty is an ANSWER (delisted names look exactly like
    // this), so it is cacheable — but on a short TTL, and it must not be
    // mistaken for "this company never traded".
    coverageGaps.add(ticker.toUpperCase());
    await liveCacheSet(key, encode([])).catch(() => {});
    return null;
  }

  const encoded = encode(fetched);
  await liveCacheSet(key, encoded).catch(() => {});
  return sliceWithinCoverage(encoded, ticker, from, to);
}

/**
 * Finviz's retention wall, conservatively. Measured 2026-08-03: AAPL daily
 * went back ~10.05y (2,522 sessions to 2016-07). 9.5y leaves margin.
 *
 * This is the RIGHT discriminator, and the naive one ("earlier than our
 * earliest session") is wrong: a ticker that listed in 2021 legitimately has
 * no bars before 2021, and Polygon has none either, so declining there would
 * throw away a perfectly good answer and pay for a redundant Polygon call on
 * every young company. What we cannot answer is a window reaching past the
 * RETENTION boundary, where Finviz's silence means "aged out", not "never
 * traded" — and Polygon does have that history.
 */
const RETENTION_YEARS = 9.5;

function retentionHorizon(now = Date.now()): string {
  return new Date(now - RETENTION_YEARS * 365.25 * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Slice, unless the requested window reaches past Finviz's retention — in
 * which case DECLINE (null) so Polygon serves the whole window from one
 * consistent source, rather than returning a silently shortened series.
 */
function sliceWithinCoverage(
  cached: CachedBars,
  ticker: string,
  from: string,
  to: string,
): Bar[] | null {
  if (from < retentionHorizon()) {
    depthShortfalls.add(ticker.toUpperCase());
    return null;
  }
  return sliceBars(cached, from, to);
}

/** Most recent completed session for one ticker, or null if uncovered. */
export async function getFinvizPreviousClose(ticker: string): Promise<Bar | null> {
  // A wide window costs nothing extra: the fetch is unranged and the cache
  // is shared with every other window for this ticker.
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
  const bars = await getFinvizDailyBars(ticker, from, to);
  if (!bars || bars.length === 0) return null;
  return bars[bars.length - 1];
}
