// GET /api/trend-scanner[?universe=russell2k][&limit=40][&minSources=1]
//
// STEP 1 OF THE SOCIAL-ARBITRAGE WORKFLOW: what changed this week.
//
// Every other Camillo surface in this app is ticker-first — you bring a name
// and it tells you about it. This one is trend-first: it sweeps the consumer
// watchlist, measures CHANGE across independent attention sources, and returns
// the names where at least one source moved.
//
// IT RETURNS AN ALPHABETICAL LIST, NOT A LEAGUE TABLE. That is a deliberate
// constraint inherited from `reports/trend/social-arb-study.md`, whose
// pre-committed gate forbids a ranked or scored version of this board until a
// forward test beats a random control. See `shared/trend-detect.ts` for the
// full reasoning — it is the whole design, not a disclaimer bolted on.
//
// Every response also RECORDS a paper trail (flagged names + a seeded random
// control cohort drawn the same day) so that the six-to-twelve month clock the
// gate specifies is actually running instead of being discussed.

import type { Handler } from '@netlify/functions';
import { z } from 'zod';
import { finvizEnabled } from './shared/finviz';
import { consumerWatchlist, DEFAULT_WATCHLIST_LIMIT } from './shared/consumer-universe';
import { scanForTrends, type ScanInput } from './shared/trend-detect';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'trend-scanner' });

/** Firestore: one doc per day, written once and never edited. */
export const COHORT_COLLECTION = 'trendDetectCohorts';

/** Hard cap. Each name costs a Wikipedia resolve, a pageview pull and a
 *  Quiver call, and the function has a 26s budget. */
const MAX_LIMIT = 60;
const MIN_LIMIT = 5;

/**
 * Zod at the boundary, per the repo's standing rule.
 *
 * The coercions matter: `?limit=-5` reaching `.slice(0, -5)` would silently
 * drop the LAST five names instead of taking the first five, and `?limit=0`
 * would return an empty board that reads as "nothing is trending" — a claim
 * about the world we did not measure.
 */
const Query = z.object({
  universe: z.enum(['russell2k', 'sp500']).default('russell2k'),
  limit: z.coerce.number().int().min(MIN_LIMIT).max(MAX_LIMIT).catch(DEFAULT_WATCHLIST_LIMIT),
  minSources: z.coerce.number().int().min(1).max(2).catch(1),
});

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json',
      // Only a SUCCESSFUL scan is cacheable. The previous shape put
      // `max-age=900` on every response, so a single upstream outage pinned a
      // 502 into the CDN for fifteen minutes and the board stayed broken long
      // after the provider recovered.
      'cache-control': status === 200 ? 'public, max-age=300' : 'private, no-store',
    },
    body: JSON.stringify(body),
  };
}

/**
 * Record the day's flagged set and its control cohort.
 *
 * `create()` rather than `set()`: the FIRST scan of a day is the timestamped
 * observation and later refreshes must not overwrite it. That is the same
 * anti-cheat invariant `shared/forward-test.ts` runs on — entries are written
 * the day they happen and never edited — and without it a cohort could be
 * quietly re-rolled once the returns were known.
 *
 * Best-effort: losing the record must not fail the request.
 */
async function recordPaperTrail(
  trail: { date: string; universeScanned: string[] },
  universe: string,
): Promise<'written' | 'exists' | 'failed'> {
  // Keyed by the SHAPE of the scan, not just the date. A ?limit=5 probe and
  // the real 40-name sweep are different cohorts and both deserve a record;
  // keying on the date alone let whichever ran first silently own the day.
  const docId = `${trail.date}_${universe}_${trail.universeScanned.length}`;
  try {
    const db = getAdminDb();
    await db.collection(COHORT_COLLECTION).doc(docId).create({
      ...trail,
      universe,
      recordedAt: new Date().toISOString(),
    });
    return 'written';
  } catch (err: any) {
    // ALREADY_EXISTS is code 6 — the expected path on any refresh.
    if (err?.code === 6 || /already exists/i.test(String(err?.message ?? ''))) return 'exists';
    log.warn('paper_trail_write_failed', { err: String(err?.message ?? err) });
    return 'failed';
  }
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const parsed = Query.safeParse(event.queryStringParameters ?? {});
  if (!parsed.success) {
    return json(400, { ok: false, error: 'bad query', detail: parsed.error.flatten() });
  }
  const { universe, limit, minSources } = parsed.data;

  if (!finvizEnabled()) {
    return json(503, { ok: false, error: 'FINVIZ_AUTH_TOKEN not configured' });
  }

  try {
    const rows = await consumerWatchlist(limit, universe);

    // A dead universe feed is a 502, never an empty board. An empty
    // "nothing is trending" is a claim about the world, and we did not
    // measure it.
    if (!rows) {
      log.error('universe_fetch_failed', { universe });
      return json(502, { ok: false, error: 'finviz universe fetch failed' });
    }

    const input: ScanInput[] = rows.map((r) => ({
      ticker: r.ticker,
      context: {
        marketCapM: r.marketCapM ?? null,
        price: r.price ?? null,
        perfWeekPct: r.perfWeekPct ?? null,
        perfMonthPct: r.perfMonthPct ?? null,
        avgVolume: r.avgVolume ?? null,
        shortFloatPct: r.shortFloatPct ?? null,
        instOwnPct: r.instOwnPct ?? null,
        earningsDate: r.earningsDate ?? null,
      },
    }));

    const result = await scanForTrends(input);
    const candidates = result.candidates.filter((c) => c.convergence >= minSources);
    const recorded = await recordPaperTrail(result.paperTrail, universe);

    log.info('response', {
      status: 200, universe, scanned: rows.length,
      candidates: candidates.length, degraded: result.degraded.length,
      mentionDays: result.mentionHistory.daysRecorded, recorded,
      durationMs: Date.now() - start,
    });

    return json(200, {
      ok: true,
      universe,
      asOf: result.asOf,
      universeChecked: result.universeChecked,
      sectorFilter: ['Consumer Cyclical', 'Consumer Defensive'],
      minSources,
      order: result.order,
      candidates,
      mentionHistory: result.mentionHistory,
      paperTrail: { ...result.paperTrail, recorded },
      degraded: result.degraded,
      caveat: result.caveat,
      // Travels in the contract so no UI can present this as a measured edge.
      disclaimer:
        'Candidate generator, not a signal, and NOT RANKED — rows are alphabetical and every measurement ' +
        'is attached so you can sort them yourself. The attention leg measured NO_EDGE in this system\'s ' +
        'own study; a ranked version is pre-committed against until forward paper signals beat the ' +
        'recorded random control cohort.',
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('failed', { err: msg, durationMs: Date.now() - start });
    return json(500, { ok: false, error: msg });
  }
};
