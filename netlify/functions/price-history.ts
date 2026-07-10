// GET /api/price-history?ticker=AAPL&range=6M
//
// Phase 4j W3 — daily price-bar feed for the detail-panel PriceChart.
// Wraps shared/data-provider.ts getDailyBars(); computes the `from` date
// from the requested range. Cached per-ticker-per-range with a date
// stamp - daily bars only change once a day, so a same-day repeat call
// serves from cache without re-hitting Polygon.
//
// Ranges:
//   1D  - DESK-1: minute bars for the most recent session (5-min cache TTL)
//   5D  - DESK-1: 5-minute bars for the last 5 sessions (5-min cache TTL)
//   1M  - 30  days back from today
//   3M  - 91  days back
//   6M  - 182 days back (default; what Chad sees on first open)
//   1Y  - 365 days back
//   5Y  - 1825 days back
//   All - 2000-01-01 → today. Polygon returns whatever exists, which
//         for a post-IPO ticker is since-listing. Plan-gated history
//         pre-2003-ish is a documented limit in data-provider.ts.
//
// DESK-1 intraday degrade: if the Polygon plan rejects intraday
// resolution (403 / NOT_AUTHORIZED), 1D/5D degrade gracefully to daily
// bars + `intradayUnavailable: true`; the UI hides the 1D/5D toggles.
// The chart NEVER errors because of a plan limitation.

import type { Handler } from '@netlify/functions';
import { getDailyBars, getIntradayBarsWithStatus, type Bar } from './shared/data-provider';
import {
  PRICE_HISTORY_COLLECTION, readRangeCache, writeRangeCache,
  toPriceBar, toIntradayPriceBar, todayUtc, isIntradayFresh,
  type PriceBar, type CachedRange,
} from './shared/price-history-cache';
import { createLogger } from './shared/logger';

const log = createLogger('price-history');

const VALID_RANGES = ['1D', '5D', '1M', '3M', '6M', '1Y', '5Y', 'All'] as const;
type Range = (typeof VALID_RANGES)[number];

const INTRADAY_RANGES = new Set<Range>(['1D', '5D']);
const ALL_RANGE_FROM = '2000-01-01';

export type { PriceBar };

export const handler: Handler = async (event) => {
  const start = Date.now();
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  const rangeRaw = (event.queryStringParameters?.range ?? '6M').trim();

  if (!ticker) return json(400, { ok: false, error: 'ticker required' });
  if (!isRange(rangeRaw)) {
    return json(400, {
      ok: false,
      error: `invalid range: ${rangeRaw}. Allowed: ${VALID_RANGES.join(', ')}`,
    });
  }
  const range: Range = rangeRaw;
  const today = todayUtc();

  try {
    if (INTRADAY_RANGES.has(range)) {
      return await handleIntraday(ticker, range, today, start);
    }

    // Cache read - same-day hit returns instantly.
    const cached = await readRangeCache(ticker, range);
    if (cached && cached.asOfDate === today) {
      log.info('response', {
        status: 200,
        ticker,
        range,
        cached: true,
        bars: cached.bars.length,
        durationMs: Date.now() - start,
      });
      return json(200, {
        ok: true,
        ticker,
        range,
        bars: cached.bars,
        cached: true,
        asOfDate: cached.asOfDate,
      });
    }

    // Miss or stale - hit Polygon.
    const from = computeFrom(range, today);
    const bars = await getDailyBars(ticker, from, today);
    const mapped = bars.map(toPriceBar);

    // Write-through. Best-effort; if Firestore is unavailable the
    // response still succeeds (we just won't have a cache next time).
    await writeRangeCache(ticker, range, { asOfDate: today, bars: mapped }).catch((err) => {
      log.warn('cache_write_failed', { ticker, range, err: String(err?.message ?? err) });
    });

    log.info('response', {
      status: 200,
      ticker,
      range,
      cached: false,
      bars: mapped.length,
      durationMs: Date.now() - start,
    });
    return json(200, {
      ok: true,
      ticker,
      range,
      bars: mapped,
      cached: false,
      asOfDate: today,
    });
  } catch (err: any) {
    log.error('failed', { ticker, range, error: err, durationMs: Date.now() - start });
    return json(500, { ok: false, ticker, range, error: String(err?.message ?? err) });
  }
};

// ---------------------------------------------------------------------------
// DESK-1 — intraday ranges (1D / 5D)
// ---------------------------------------------------------------------------

async function handleIntraday(ticker: string, range: Range, today: string, start: number) {
  const nowMs = Date.now();

  const cached = await readRangeCache(ticker, range);
  if (cached && isIntradayFresh(cached, nowMs)) {
    log.info('response', {
      status: 200, ticker, range, cached: true,
      bars: cached.bars.length,
      intradayUnavailable: !!cached.intradayUnavailable,
      durationMs: Date.now() - start,
    });
    return json(200, {
      ok: true, ticker, range,
      bars: cached.bars,
      cached: true,
      asOfDate: cached.asOfDate,
      ...(cached.intradayUnavailable ? { intradayUnavailable: true } : {}),
    });
  }

  // Fetch a padded window (weekends/holidays), then slice to the last
  // 1 or 5 distinct session dates actually present.
  const sessions = range === '1D' ? 1 : 5;
  const multiplier = range === '1D' ? 1 : 5;
  const padDays = range === '1D' ? 4 : 9;
  const from = new Date(nowMs - padDays * 86_400_000).toISOString().slice(0, 10);

  const { bars: rawBars, unauthorized } = await getIntradayBarsWithStatus(
    ticker, multiplier, 'minute', from, today,
  );

  if (unauthorized) {
    // Plan-gated: degrade to daily bars, flag it, cache the degrade so
    // we don't re-probe Polygon every 5 minutes.
    const dailyFrom = computeFrom('1M', today);
    const daily = (await getDailyBars(ticker, dailyFrom, today)).map(toPriceBar);
    const payload: CachedRange = {
      asOfDate: today, asOfMs: nowMs, bars: daily, intradayUnavailable: true,
    };
    await writeRangeCache(ticker, range, payload).catch((err) => {
      log.warn('cache_write_failed', { ticker, range, err: String(err?.message ?? err) });
    });
    log.info('response', {
      status: 200, ticker, range, cached: false,
      intradayUnavailable: true, bars: daily.length,
      durationMs: Date.now() - start,
    });
    return json(200, {
      ok: true, ticker, range,
      bars: daily,
      cached: false,
      asOfDate: today,
      intradayUnavailable: true,
    });
  }

  const mapped = sliceToLastSessions(rawBars, sessions).map(toIntradayPriceBar);
  const payload: CachedRange = { asOfDate: today, asOfMs: nowMs, bars: mapped };
  await writeRangeCache(ticker, range, payload).catch((err) => {
    log.warn('cache_write_failed', { ticker, range, err: String(err?.message ?? err) });
  });

  log.info('response', {
    status: 200, ticker, range, cached: false,
    bars: mapped.length, durationMs: Date.now() - start,
  });
  return json(200, {
    ok: true, ticker, range,
    bars: mapped,
    cached: false,
    asOfDate: today,
  });
}

/** Keep only bars belonging to the last `sessions` distinct UTC dates. */
export function sliceToLastSessions(bars: Bar[], sessions: number): Bar[] {
  if (bars.length === 0) return [];
  const dates = [...new Set(bars.map((b) => new Date(b.t).toISOString().slice(0, 10)))].sort();
  const keep = new Set(dates.slice(-sessions));
  return bars.filter((b) => keep.has(new Date(b.t).toISOString().slice(0, 10)));
}

// ---------------------------------------------------------------------------
// Range math
// ---------------------------------------------------------------------------

export function computeFrom(range: Range, today: string): string {
  if (range === 'All') return ALL_RANGE_FROM;
  const days =
    range === '1M' ? 30 :
    range === '3M' ? 91 :
    range === '6M' ? 182 :
    range === '1Y' ? 365 :
    range === '5Y' ? 1825 : 365;
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`bad today: ${today}`);
  return new Date(t - days * 86_400_000).toISOString().slice(0, 10);
}

function isRange(s: string): s is Range {
  return (VALID_RANGES as readonly string[]).includes(s);
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Browser-side: 5-minute cache is plenty given daily bars only
      // change once a day. The Firestore cache is the authoritative
      // dedupe layer; the browser cache is just a polish.
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(body),
  };
}

// Exposed for tests.
export const _internals = {
  COLLECTION: PRICE_HISTORY_COLLECTION,
  ALL_RANGE_FROM,
  VALID_RANGES,
  INTRADAY_RANGES,
};
