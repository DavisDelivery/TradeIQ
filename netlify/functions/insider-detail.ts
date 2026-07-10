// GET /api/insider-detail?ticker=AAPL
//
// DESK-1 W3 (scope deviation, flagged in the PR): the dossier INSIDER
// tab needs the per-ticker 90d transaction LIST (last 10 filings table)
// plus net buy/sell dollars. No existing endpoint returns the list —
// /api/stock-detail carries only {net90dDollarVolume, last} and the
// insider BOARD is universe-scoped. This thin endpoint wraps the
// existing throttled provider (getInsiderActivity → Finnhub token
// bucket) with a DAILY Firestore cache (`insiderDetail/{ticker}`) so a
// dossier open costs at most one Finnhub call per ticker per day.
//
// Honest no-data discipline (M8): a Finnhub transport failure returns
// ok:true with `dataUnavailable: true` — never a fabricated "no insider
// activity". Verified-empty (HTTP 200, zero transactions) returns real
// zeros.

import type { Handler } from '@netlify/functions';
import type { Firestore } from 'firebase-admin/firestore';
import { getInsiderActivity, type InsiderActivity } from './shared/insider-provider';
import { getAdminDb } from './shared/firebase-admin';
import { createLogger } from './shared/logger';

const log = createLogger('insider-detail');

const COLLECTION = 'insiderDetail';
const LOOKBACK_DAYS = 90;
const MAX_FILINGS = 10;

export interface InsiderDetailResponse {
  ok: boolean;
  ticker: string;
  lookbackDays: number;
  /** True when Finnhub failed — data is MISSING, not absent. */
  dataUnavailable?: boolean;
  netDollars?: number;
  buyDollars?: number;
  sellDollars?: number;
  totalBuys?: number;
  totalSells?: number;
  uniqueBuyers?: number;
  filings?: Array<{
    name: string;
    position: string;
    transactionCode: string;
    transactionDate: string;
    filingDate: string;
    share: number;
    transactionPrice: number;
    dollarValue: number;
  }>;
  asOfDate?: string;
  cached?: boolean;
  error?: string;
}

interface CachedDetail {
  asOfDate: string;
  detail: Omit<InsiderDetailResponse, 'ok' | 'cached'>;
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  if (!ticker) return json(400, { ok: false, ticker: '', lookbackDays: LOOKBACK_DAYS, error: 'ticker required' });

  const today = new Date().toISOString().slice(0, 10);

  try {
    const cached = await readCache(ticker);
    // Serve a same-day cache hit — but never a cached transport failure;
    // retry those so a transient Finnhub blip doesn't stick for a day.
    if (cached && cached.asOfDate === today && !cached.detail.dataUnavailable) {
      log.info('response', { status: 200, ticker, cached: true, durationMs: Date.now() - start });
      return json(200, { ok: true, cached: true, ...cached.detail });
    }

    const activity = await getInsiderActivity(ticker, LOOKBACK_DAYS);
    const detail = buildDetail(ticker, activity, today);

    if (!detail.dataUnavailable) {
      await writeCache(ticker, { asOfDate: today, detail }).catch((err) => {
        log.warn('cache_write_failed', { ticker, err: String(err?.message ?? err) });
      });
    }

    log.info('response', {
      status: 200, ticker, cached: false,
      unavailable: !!detail.dataUnavailable,
      filings: detail.filings?.length ?? 0,
      durationMs: Date.now() - start,
    });
    return json(200, { ok: true, cached: false, ...detail });
  } catch (err: any) {
    log.error('failed', { ticker, error: err, durationMs: Date.now() - start });
    return json(500, { ok: false, ticker, lookbackDays: LOOKBACK_DAYS, error: String(err?.message ?? err) });
  }
};

// ---------------------------------------------------------------------------
// Assembly (exported for tests)
// ---------------------------------------------------------------------------

export function buildDetail(
  ticker: string,
  activity: InsiderActivity | null,
  asOfDate: string,
): Omit<InsiderDetailResponse, 'ok' | 'cached'> {
  if (!activity) {
    return { ticker, lookbackDays: LOOKBACK_DAYS, dataUnavailable: true, asOfDate };
  }
  // Newest filings first, cap at 10 for the dossier table.
  const filings = [...activity.transactions]
    .sort((a, b) => (a.filingDate < b.filingDate ? 1 : a.filingDate > b.filingDate ? -1 : 0))
    .slice(0, MAX_FILINGS)
    .map((t) => ({
      name: t.name,
      position: t.position,
      transactionCode: t.transactionCode,
      transactionDate: t.transactionDate,
      filingDate: t.filingDate,
      share: t.share,
      transactionPrice: t.transactionPrice,
      dollarValue: Math.round(Math.abs(t.share) * t.transactionPrice),
    }));

  return {
    ticker,
    lookbackDays: activity.lookbackDays,
    netDollars: Math.round(activity.netDollars),
    buyDollars: Math.round(activity.buyDollars),
    sellDollars: Math.round(activity.sellDollars),
    totalBuys: activity.totalBuys,
    totalSells: activity.totalSells,
    uniqueBuyers: activity.uniqueBuyers,
    filings,
    asOfDate,
  };
}

// ---------------------------------------------------------------------------
// Firestore cache (daily TTL)
// ---------------------------------------------------------------------------

async function readCache(ticker: string, dbOverride?: Firestore): Promise<CachedDetail | null> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return null;
  }
  try {
    const snap = await db.collection(COLLECTION).doc(ticker).get();
    if (!snap.exists) return null;
    return (snap.data() as CachedDetail | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeCache(ticker: string, payload: CachedDetail, dbOverride?: Firestore): Promise<void> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return;
  }
  await db.collection(COLLECTION).doc(ticker).set(payload);
}

function json(statusCode: number, body: InsiderDetailResponse) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(body),
  };
}

// Exposed for tests.
export const _internals = { COLLECTION, LOOKBACK_DAYS, MAX_FILINGS };
