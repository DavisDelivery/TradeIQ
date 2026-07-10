// GET /api/earnings-radar?tickers=AAPL,MSFT,...
//
// DESK-1 W1 — earnings proximity + beat history for the Desk watchlist
// and the dossier EARNINGS tab. Per ticker:
//
//   nextEarningsDate / daysUntil — Finnhub calendar (90d lookahead)
//   beatsLast4 / beatsLast4Quarters — the HONEST denominator from
//     earnings-intel's computeBeatMetrics (null ≠ 0 beats; ≤4 quarters
//     is normal for newer tickers)
//   lastSurprisePct — most recent quarter's surprise %
//   surpriseHistory — last 4 reports (dossier detail)
//
// Firestore-cached per ticker with a DAILY TTL (collection
// `earningsRadar`) — earnings dates and past surprises don't move
// intraday. All Finnhub calls pace through the shared 55rpm token
// bucket. A bad ticker never throws the batch (skip + warn).

import type { Handler } from '@netlify/functions';
import type { Firestore } from 'firebase-admin/firestore';
import {
  getEarningsHistory, getUpcomingEarnings, type EarningsSurprise,
} from './shared/data-provider';
import { computeBeatMetrics } from './shared/earnings-intel';
import { getFinnhubBucket } from './shared/rate-limiter';
import { getAdminDb } from './shared/firebase-admin';
import { createLogger } from './shared/logger';

const log = createLogger('earnings-radar');

const COLLECTION = 'earningsRadar';
const MAX_TICKERS = 60;
const CONCURRENCY = 4;

export interface EarningsRadarEntry {
  ticker: string;
  nextEarningsDate: string | null;
  daysUntil: number | null;
  epsEstimateNext: number | null;
  beatsLast4: number | null;        // null = no usable surprise data (NOT zero beats)
  beatsLast4Quarters: number;       // honest denominator (0-4)
  lastSurprisePct: number | null;
  surpriseHistory: Array<{
    period: string;
    epsActual: number;
    epsEstimate: number;
    surprisePct: number | null;
  }>;
}

interface CachedEntry {
  asOfDate: string;
  entry: EarningsRadarEntry;
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const raw = event.queryStringParameters?.tickers ?? '';
  const tickers = [...new Set(
    raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  )].slice(0, MAX_TICKERS);

  if (tickers.length === 0) {
    return json(400, { ok: false, error: 'tickers required (comma-separated)' });
  }

  const today = new Date().toISOString().slice(0, 10);
  const radar: Record<string, EarningsRadarEntry> = {};
  const warnings: Array<{ ticker: string; error: string }> = [];

  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (ticker) => {
      try {
        const cached = await readCache(ticker);
        // Read-side twin of the write guard below: a fully-empty cached
        // entry (written by a pre-fix deploy during a Finnhub outage) is
        // treated as a miss so it self-heals instead of serving "no
        // data" for the rest of the day.
        const cachedEmpty = cached
          && cached.entry?.beatsLast4Quarters === 0
          && cached.entry?.nextEarningsDate === null;
        if (cached && cached.asOfDate === today && !cachedEmpty) {
          radar[ticker] = cached.entry;
          return;
        }
        const entry = await buildEntry(ticker);
        radar[ticker] = entry;
        // Post-merge prod finding (PR #102 smoke, NVDA @ ~21:00 UTC cron
        // contention): getEarningsHistory/getUpcomingEarnings silently
        // return []/null on Finnhub transport failure, and caching that
        // pinned a rate-limited moment as "no data" for the whole day.
        // Same discipline as insider-detail: a fully-empty entry (no
        // history AND no calendar hit) is indistinguishable from a
        // failure — serve it, but do NOT cache it, so the next request
        // retries. Genuinely data-less tickers just re-fetch (2 paced
        // calls per open — acceptable).
        const possiblyFailed = entry.beatsLast4Quarters === 0 && entry.nextEarningsDate === null;
        if (!possiblyFailed) {
          await writeCache(ticker, { asOfDate: today, entry }).catch((err) => {
            log.warn('cache_write_failed', { ticker, err: String(err?.message ?? err) });
          });
        }
      } catch (err: any) {
        warnings.push({ ticker, error: String(err?.message ?? err) });
        log.warn('ticker_failed', { ticker, err: String(err?.message ?? err) });
      }
    }));
  }

  log.info('response', {
    status: 200,
    requested: tickers.length,
    returned: Object.keys(radar).length,
    warnings: warnings.length,
    durationMs: Date.now() - start,
  });
  return json(200, {
    ok: true,
    asOf: new Date().toISOString(),
    radar,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
};

// ---------------------------------------------------------------------------
// Entry assembly (exported for tests)
// ---------------------------------------------------------------------------

export async function buildEntry(ticker: string): Promise<EarningsRadarEntry> {
  // Pace BOTH Finnhub calls through the shared 55rpm bucket. The
  // history call inside data-provider does not self-acquire (it predates
  // the bucket), so acquire here for each upstream round-trip.
  await getFinnhubBucket().acquire();
  const history = await getEarningsHistory(ticker, 8).catch(() => [] as EarningsSurprise[]);
  await getFinnhubBucket().acquire();
  const upcoming = await getUpcomingEarnings(ticker, 90).catch(() => null);

  return assembleEntry(ticker, history, upcoming?.date ?? null, upcoming?.epsEstimate ?? null);
}

export function assembleEntry(
  ticker: string,
  history: EarningsSurprise[],
  nextEarningsDate: string | null,
  epsEstimateNext: number | null,
  nowMs: number = Date.now(),
): EarningsRadarEntry {
  const beats = computeBeatMetrics(history);
  const daysUntil = nextEarningsDate
    ? Math.round((new Date(`${nextEarningsDate}T12:00:00Z`).getTime() - nowMs) / 86_400_000)
    : null;

  return {
    ticker,
    nextEarningsDate,
    daysUntil,
    epsEstimateNext,
    beatsLast4: beats.beatsLast4,
    beatsLast4Quarters: beats.beatsLast4Quarters,
    lastSurprisePct: beats.latestSurprisePct ?? null,
    surpriseHistory: history.slice(0, 4).map((r) => ({
      period: r.period,
      epsActual: r.epsActual,
      epsEstimate: r.epsEstimate,
      surprisePct: Number.isFinite(r.surprisePct as number) ? (r.surprisePct as number) : null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Firestore cache (daily TTL)
// ---------------------------------------------------------------------------

async function readCache(ticker: string, dbOverride?: Firestore): Promise<CachedEntry | null> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return null;
  }
  try {
    const snap = await db.collection(COLLECTION).doc(ticker).get();
    if (!snap.exists) return null;
    return (snap.data() as CachedEntry | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeCache(ticker: string, payload: CachedEntry, dbOverride?: Firestore): Promise<void> {
  let db: Firestore;
  try {
    db = dbOverride ?? getAdminDb();
  } catch {
    return;
  }
  await db.collection(COLLECTION).doc(ticker).set(payload);
}

function json(statusCode: number, body: unknown) {
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
export const _internals = { COLLECTION, MAX_TICKERS, CONCURRENCY };
