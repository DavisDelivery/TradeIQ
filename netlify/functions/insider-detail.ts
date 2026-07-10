// GET /api/insider-detail?ticker=AAPL
//
// DESK-1 W3 (scope deviation, flagged in the PR): the dossier INSIDER
// tab needs the per-ticker 90d transaction LIST (last 10 filings table)
// plus net buy/sell dollars. No existing endpoint returns the list —
// /api/stock-detail carries only {net90dDollarVolume, last} and the
// insider BOARD is universe-scoped.
//
// Post-smoke fix (preview PR #102): insider-provider's
// InsiderActivity.transactions carries BUYS ONLY (code 'P'), so a
// sell-heavy name (AAPL) showed net −$87M with an empty filings table.
// This endpoint now consumes the raw throttled provider directly — ONE
// Finnhub call through the shared token bucket — and computes both the
// aggregates and the full filings list (buys, sells, and awards, each
// labeled by its transaction code) itself. Aggregate semantics match
// insider-provider exactly: buys = code 'P' with positive delta
// (awards 'A' excluded — scheduled grants carry no signal), sells =
// code 'S' with negative delta.
//
// Daily Firestore cache (`insiderDetail/{ticker}`) so a dossier open
// costs at most one Finnhub call per ticker per day.
//
// Honest no-data discipline (M8): a Finnhub transport failure returns
// ok:true with `dataUnavailable: true` — never a fabricated "no insider
// activity" — and is never cached. Verified-empty (HTTP 200, zero
// transactions) returns real zeros.

import type { Handler } from '@netlify/functions';
import type { Firestore } from 'firebase-admin/firestore';
import {
  getFinnhubInsiderTransactionsWithStatus,
  type FinnhubInsiderTx,
} from './shared/data-provider';
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
    /** Signed share delta (Finnhub `change`): >0 acquired, <0 disposed. */
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

    // ONE throttled Finnhub call (token bucket inside the provider).
    const status = await getFinnhubInsiderTransactionsWithStatus(ticker, LOOKBACK_DAYS);
    const failed = status.rateLimitExhausted || !!status.errorMessage;
    const detail = buildDetail(ticker, failed ? null : status.data, today);

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
  raw: FinnhubInsiderTx[] | null,
  asOfDate: string,
): Omit<InsiderDetailResponse, 'ok' | 'cached'> {
  if (raw === null) {
    return { ticker, lookbackDays: LOOKBACK_DAYS, dataUnavailable: true, asOfDate };
  }

  // Finnhub `change` is the signed delta; `share` is the post-transaction
  // holding. Direction and sizing use `change` (same convention as
  // insider-provider). Rows with an unusable delta are dropped.
  const usable = raw.filter(
    (t) => t && t.name && t.transactionDate && Number.isFinite(t.change),
  );

  // Aggregate semantics mirror insider-provider: 'P' = real open-market
  // buys ('A' awards excluded — scheduled grants, no signal); 'S' = sells.
  const price = (t: FinnhubInsiderTx) =>
    Number.isFinite(t.transactionPrice) && t.transactionPrice > 0 ? t.transactionPrice : 0;
  const buys = usable.filter((t) => t.transactionCode === 'P' && t.change > 0);
  const sells = usable.filter((t) => t.transactionCode === 'S' && t.change < 0);
  const buyDollars = buys.reduce((a, t) => a + t.change * price(t), 0);
  const sellDollars = sells.reduce((a, t) => a + Math.abs(t.change) * price(t), 0);

  // Filings table: ALL codes (buys, sells, awards) so the dossier shows
  // what was actually filed — the code column labels each row honestly.
  const filings = [...usable]
    .sort((a, b) => (a.filingDate < b.filingDate ? 1 : a.filingDate > b.filingDate ? -1 : 0))
    .slice(0, MAX_FILINGS)
    .map((t) => ({
      name: t.name,
      position: '', // role enrichment (EDGAR) is a scan-path luxury; '—' in UI
      transactionCode: t.transactionCode,
      transactionDate: t.transactionDate,
      filingDate: t.filingDate,
      share: t.change,
      transactionPrice: t.transactionPrice,
      dollarValue: Math.round(Math.abs(t.change) * price(t)),
    }));

  return {
    ticker,
    lookbackDays: LOOKBACK_DAYS,
    netDollars: Math.round(buyDollars - sellDollars),
    buyDollars: Math.round(buyDollars),
    sellDollars: Math.round(sellDollars),
    totalBuys: buys.length,
    totalSells: sells.length,
    uniqueBuyers: new Set(buys.map((t) => t.name)).size,
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
