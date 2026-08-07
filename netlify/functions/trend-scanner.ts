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
import { DEFAULT_WATCHLIST_LIMIT, selectConsumerRows } from './shared/consumer-universe';
import { getFinvizUniverseSnapshot } from './shared/finviz';
import { POLICY_VERSION } from './shared/research-policy';
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
  minSources: z.coerce.number().int().min(1).max(3).catch(1),
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
 * Is this request being served by the production deploy?
 *
 * DERIVED FROM THE REQUEST, NOT THE ENVIRONMENT, and that is the whole point.
 * The first attempt at this guard tested `process.env.CONTEXT !== 'production'`,
 * which reads correctly and does nothing: CONTEXT is a BUILD variable and is
 * not present in the function runtime. Verified against the live preview —
 * the endpoint reported `recorded: 'written'` from deploy-preview-196 with the
 * guard supposedly in place. The Host header cannot be absent or wrong,
 * because it is what routed the request here.
 *
 * Netlify's non-production hostnames are structural: `deploy-preview-<n>--`,
 * `<branch>--`, and `<deploy-id>--`. All of them contain `--`, and no
 * production hostname does. That is the test, so a custom domain added later
 * still records rather than silently going quiet — the failure mode that
 * matters here is a forward record that stops without anyone noticing.
 */
export function isProductionHost(host: string | undefined): boolean {
  const h = (host ?? '').toLowerCase().split(':')[0].trim();
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.local')) return false;
  return !h.includes('--');
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
  host: string | undefined,
): Promise<'written' | 'exists' | 'failed' | 'skipped-non-production'> {
  // PRODUCTION ONLY. Deploy previews share the production Firebase project
  // (FIREBASE_SERVICE_ACCOUNT is set across all contexts), so smoke-testing
  // this endpoint on a preview writes real, immutable rows into the forward
  // record — and `create()` means the first write wins permanently, so a
  // probe against a half-built branch owns that day forever. Not
  // hypothetical: the pre-fix build of this PR wrote a 7-name cohort for
  // 2026-08-06, four of whose names came from a source since reclassified as
  // saturation.
  if (!isProductionHost(host)) return 'skipped-non-production';

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
    const snap = await getFinvizUniverseSnapshot(universe).catch(() => null);

    // A dead universe feed is a 502, never an empty board. An empty
    // "nothing is trending" is a claim about the world, and we did not
    // measure it.
    if (!snap) {
      log.error('universe_fetch_failed', { universe });
      return json(502, { ok: false, error: 'finviz universe fetch failed' });
    }

    const selection = selectConsumerRows(snap.rows ?? [], limit);
    const rows = selection.kept;

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
    const host = event.headers?.host ?? event.headers?.Host;
    const recorded = await recordPaperTrail(result.paperTrail, universe, host);

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
      // The ratified floors (PR #198) and exactly what they removed. A
      // universe that claims to be the consumer universe has to be able to
      // show its own cut.
      universePolicy: { version: POLICY_VERSION, excludedCounts: selection.counts },
      minSources,
      order: result.order,
      candidates,
      mentionHistory: result.mentionHistory,
      appRatingHistory: result.appRatingHistory,
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
