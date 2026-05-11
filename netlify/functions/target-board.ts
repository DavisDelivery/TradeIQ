// GET /api/target-board?limit=50&universe=all|sp500|ndx|dow|russell|russell2k|core[&force=1]
//
// Phase 1 behavior:
//   - Default: read latest snapshot from Firestore. If fresh, return immediately
//     (`source: 'snapshot'`). If stale or missing, fall back to a synchronous
//     capped scan (`source: 'fallback-partial'`). Snapshot stale = log warning;
//     scheduled scan is failing.
//   - ?force=1: skip snapshot, run synchronous capped scan, return with
//     `source: 'forced-partial'`. Escape hatch for the UI's "Force rescan" button.
//
// Snapshots are populated by netlify/functions/scan-target-board.ts
// every 30 min during US market hours.

import type { Handler } from '@netlify/functions';
import type { TargetBoardResponse } from './shared/types';
import {
  runTargetScan,
  type TargetUniverseKey,
} from './shared/scan-target';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';

const PASS1_MAX_LIVE = 80;
const PASS2_MAX_LIVE = 20;
const SCAN_BUDGET_MS = 24_000;

// Resilience: cache the live partial-scan result in-memory so a second
// concurrent request inside the same warm container doesn't double-scan.
const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Number(qs.limit ?? 50), 100);
  const universe = (qs.universe as TargetUniverseKey) ?? 'core';
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'target-board', universe, force });

  // Map "russell" → "russell2k" for the snapshot store key.
  const snapshotUniverse: UniverseKey =
    universe === 'russell' ? 'russell2k' : (universe as UniverseKey);

  // Path 1: forced rescan.
  if (force) {
    log.info('forced_partial_scan');
    return runLiveAndRespond(universe, limit, 'forced-partial', log);
  }

  // Path 2: snapshot-first.
  try {
    const snap = await latestSnapshot('target-board', snapshotUniverse);
    if (snap && isSnapshotFresh(snap)) {
      const ageMs = snapshotAgeMs(snap);
      log.info('snapshot_hit', {
        ageMs,
        modelVersion: snap.modelVersion,
        resultsCount: snap.results.length,
      });
      const results = snap.results as any[];
      return json(200, {
        targets: results.slice(0, limit),
        generatedAt: snap.generatedAt,
        source: 'snapshot',
        universe,
        cached: true,
        ageMs,
        modelVersion: snap.modelVersion,
        universeSize: snap.universeChecked,
        tickersScanned: results.length,
        warnings: snap.warnings ?? [],
      });
    }
    if (snap) {
      log.warn('snapshot_stale', {
        ageMs: snapshotAgeMs(snap),
        budgetMs: snap.freshnessBudgetMs,
      });
    } else {
      log.warn('snapshot_missing', { board: 'target-board', universe: snapshotUniverse });
    }
  } catch (err: any) {
    log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
  }

  // Path 3: stale or missing snapshot → run capped live scan as fallback.
  return runLiveAndRespond(universe, limit, 'fallback-partial', log);
};

async function runLiveAndRespond(
  universe: TargetUniverseKey,
  limit: number,
  source: 'forced-partial' | 'fallback-partial',
  log: ReturnType<typeof logger.child>,
) {
  const cacheKey = `${universe}:${source}`;
  if (source === 'fallback-partial') {
    const cached = fallbackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
      log.info('fallback_cache_hit', { ageMs: Date.now() - cached.at });
      return json(200, { ...cached.data, cached: true, source });
    }
  }

  try {
    const scan = await runTargetScan({
      universe,
      pass1Max: PASS1_MAX_LIVE,
      pass2Max: PASS2_MAX_LIVE,
      scanBudgetMs: SCAN_BUDGET_MS,
      logger: log,
    });

    const response = {
      targets: scan.results.slice(0, limit),
      generatedAt: new Date().toISOString(),
      source,
      universe,
      cached: false,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      universeSize: scan.universeChecked,
      pass1Scanned: scan.pass1Scanned,
      tickersScanned: scan.results.length,
      warning:
        source === 'fallback-partial'
          ? 'snapshot stale or missing; this is a partial scan — full results return after next scheduled run'
          : 'forced partial scan; ignoring snapshot',
      warnings: scan.warnings,
    };

    if (source === 'fallback-partial' && scan.results.length > 0) {
      fallbackCache.set(cacheKey, { data: response, at: Date.now() });
    }
    return json(200, response);
  } catch (err: any) {
    log.error('live_scan_failed', { err: String(err?.message ?? err) });
    return json(500, {
      error: String(err?.message ?? err),
      targets: [],
      generatedAt: new Date().toISOString(),
      source: 'error',
      universe,
    } as TargetBoardResponse);
  }
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
    },
    body: JSON.stringify(body),
  };
}
