// GET /api/earnings-board?days=7&force=0
//
// Phase 1: snapshot-first.
//
// Default path: read the latest 30-day-window snapshot from Firestore (written
// by scan-earnings.ts twice daily) and filter setups down to the
// user's requested window (3/7/14/30) at read time. One scheduled snapshot
// covers all 4 window variants without re-running the calendar+history
// fetches per request.
//
// Force path (?force=1): skip snapshot read, run a capped 22s synchronous
// scan with the user's window directly. Returns `source: 'forced-partial'`
// so the UI can flag it.
//
// Fallback (snapshot stale or missing): same capped synchronous scan, returns
// `source: 'fallback-partial'` and emits a warning log so the missing-snapshot
// alert is visible.
//
// Caching: NEVER cache empty results (the v0.7.18/v0.7.19/v0.7.21 fix pattern
// from target-board, prophet, earnings-board). The snapshot-first read path
// is naturally exempt — empty snapshots don't get written in the first place.

import type { Handler } from '@netlify/functions';
import {
  runEarningsScan,
  filterSetupsToWindow,
  ALLOWED_WINDOWS,
  POST_PRINT_LOOKBACK_DAYS,
} from './shared/scan-earnings';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import type { EarningsBoardResponse, EarningsSetup } from './shared/types';

const FALLBACK_SCAN_BUDGET_MS = 22_000;

// Per-window fallback cache (keeps the v0.7.18 fix pattern intact).
const fallbackCache = new Map<number, { data: EarningsBoardResponse; at: number }>();
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const rawDays = Number(qs.days);
  const windowDays: number = (ALLOWED_WINDOWS as readonly number[]).includes(rawDays)
    ? rawDays
    : 7;
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'earnings-board', windowDays, force });

  // ---- Snapshot-first read path ----
  if (!force) {
    try {
      const snap = await latestSnapshot('earnings', 'all');
      if (snap && isSnapshotFresh(snap)) {
        const ageMs = snapshotAgeMs(snap);
        log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
        const allSetups = snap.results as EarningsSetup[];
        const filtered = filterSetupsToWindow(allSetups, windowDays);
        const response: EarningsBoardResponse & {
          source: string;
          ageMs: number;
          modelVersion: string;
        } = {
          setups: filtered,
          universeChecked: snap.universeChecked,
          windowDays,
          generatedAt: snap.generatedAt,
          cached: true,
          source: 'snapshot',
          ageMs,
          modelVersion: snap.modelVersion,
        };
        return json(200, response);
      }
      if (snap) log.warn('snapshot_stale', { ageMs: snapshotAgeMs(snap) });
      else log.warn('snapshot_missing');
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
    }
  }

  // ---- Capped synchronous fallback (or forced rescan) ----
  const cached = fallbackCache.get(windowDays);
  if (!force && cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
    log.info('fallback_cache_hit');
    return json(200, {
      ...cached.data,
      cached: true,
      source: 'fallback-partial' as const,
    });
  }

  try {
    log.info('running_capped_scan', { windowDays, budgetMs: FALLBACK_SCAN_BUDGET_MS });
    const scan = await runEarningsScan({
      windowDays,
      postPrintLookbackDays: windowDays >= 7 ? POST_PRINT_LOOKBACK_DAYS : 0,
      scanBudgetMs: FALLBACK_SCAN_BUDGET_MS,
      concurrency: 10,
      logger: log,
    });

    const filtered = filterSetupsToWindow(scan.setups, windowDays);

    const response: EarningsBoardResponse & {
      source: string;
      modelVersion: string;
      warning?: string;
    } = {
      setups: filtered,
      universeChecked: scan.universeChecked,
      windowDays,
      generatedAt: new Date().toISOString(),
      cached: false,
      source: force ? 'forced-partial' : 'fallback-partial',
      modelVersion: MODEL_VERSION,
      warning: force
        ? 'Force rescan ran a capped scan; for comprehensive coverage rely on the next scheduled snapshot.'
        : 'Snapshot stale or missing — partial scan served. Full coverage returns after next scheduled run.',
    };

    // CRITICAL: only cache when non-empty (cache-poisoning fix pattern).
    if (filtered.length > 0 && !force) {
      fallbackCache.set(windowDays, { data: response, at: Date.now() });
    }

    return json(200, response);
  } catch (err: any) {
    log.error('capped_scan_failed', { err: String(err?.message ?? err) });
    return json(500, {
      error: String(err?.message ?? err),
      source: 'error',
    });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
    body: JSON.stringify(body),
  };
}
