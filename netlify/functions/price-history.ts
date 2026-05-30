// GET /api/price-history?ticker=AAPL&range=6M
//
// Phase 4j W3 — daily price-bar feed for the detail-panel PriceChart.
// Wraps shared/data-provider.ts getDailyBars(); computes the `from` date
// from the requested range. Cached per-ticker-per-range with a date
// stamp - daily bars only change once a day, so a same-day repeat call
// serves from cache without re-hitting Polygon.
//
// Ranges:
//   1M  - 30  days back from today
//   3M  - 91  days back
//   6M  - 182 days back (default; what Chad sees on first open)
//   1Y  - 365 days back
//   5Y  - 1825 days back
//   All - 2000-01-01 → today. Polygon returns whatever exists, which
//         for a post-IPO ticker is since-listing. Plan-gated history
//         pre-2003-ish is a documented limit in data-provider.ts.

import type { Handler } from '@netlify/functions';
import type { Firestore } from 'firebase-admin/firestore';
import { getDailyBars, type Bar } from './shared/data-provider';
import { getAdminDb } from './shared/firebase-admin';
import { createLogger } from './shared/logger';

const log = createLogger('price-history');

const COLLECTION = 'priceHistory';
const VALID_RANGES = ['1M', '3M', '6M', '1Y', '5Y', 'All'] as const;
type Range = (typeof VALID_RANGES)[number];

const ALL_RANGE_FROM = '2000-01-01';

export interface PriceBar {
  date: string;  // YYYY-MM-DD (UTC) from the bar timestamp
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface CachedRange {
  asOfDate: string;  // YYYY-MM-DD when these bars were fetched
  bars: PriceBar[];
}

interface PriceHistoryDoc {
  ranges?: Partial<Record<Range, CachedRange>>;
}

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
    // Cache read - same-day hit returns instantly.
    const cached = await readCache(ticker, range);
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
    await writeCache(ticker, range, { asOfDate: today, bars: mapped }).catch((err) => {
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

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

function toPriceBar(b: Bar): PriceBar {
  // Polygon bar timestamp is ms since epoch (UTC). Slice to YYYY-MM-DD.
  return {
    date: new Date(b.t).toISOString().slice(0, 10),
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
  };
}

// ---------------------------------------------------------------------------
// Firestore cache
// ---------------------------------------------------------------------------

async function readCache(
  ticker: string,
  range: Range,
  dbOverride?: Firestore,
): Promise<CachedRange | null> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return null;
  }
  try {
    const snap = await db.collection(COLLECTION).doc(ticker).get();
    if (!snap.exists) return null;
    const data = snap.data() as PriceHistoryDoc | undefined;
    return data?.ranges?.[range] ?? null;
  } catch {
    return null;
  }
}

async function writeCache(
  ticker: string,
  range: Range,
  payload: CachedRange,
  dbOverride?: Firestore,
): Promise<void> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return;
  }
  // Merge so the document accumulates ranges over time - opening 1M
  // shouldn't wipe the cached 6M (or vice versa).
  await db
    .collection(COLLECTION)
    .doc(ticker)
    .set({ ranges: { [range]: payload } }, { merge: true });
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
export const _internals = { COLLECTION, ALL_RANGE_FROM, VALID_RANGES };
