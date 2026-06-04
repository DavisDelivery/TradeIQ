// GET /api/target-board?limit=50&universe=all|sp500|ndx|dow|russell|russell2k|core[&force=1]
//
// Behavior:
//   - Default: read the latest snapshot from Firestore. If fresh, return
//     immediately (`source: 'snapshot'`).
//   - Stale or missing snapshot:
//       * Large universes (russell2k, sp500) NEVER inline-scan — they
//         serve the last complete snapshot with `stale: true` so the
//         UI surfaces "as of {generatedAt}" rather than hanging 25s on
//         a live partial scan (the Phase 4h W2 de-hang). When no
//         snapshot exists at all, returns an empty-targets response
//         with `source: 'snapshot-missing'`.
//       * Small universes (dow, ndx, core, all) keep the inline-fallback
//         path: 30-100 names finish in ~2-5s, well under the 26s
//         sync ceiling.
//   - ?force=1: skip snapshot, run synchronous capped scan, return with
//     `source: 'forced-partial'`. Escape hatch for the UI's "Force rescan".
//
// Snapshots are populated by netlify/functions/scan-target-board-{universe}.ts.

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

// Universes too large to inline-scan inside a 26s request without the
// hang Phase 4h W2 removed. These ALWAYS serve a snapshot (stale-flagged
// if past the freshness budget) and never call runLiveAndRespond.
const SNAPSHOT_ONLY_UNIVERSES = new Set<TargetUniverseKey>([
  'russell2k',
  'russell',
  'sp500',
]);

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

  // Path 1: forced rescan. Large universes still refuse to inline-scan —
  // a forced rescan there returns the latest stored snapshot (or an
  // empty result) rather than hanging the request. The scheduled
  // bg-worker is the only thing that actually rescores large universes.
  if (force) {
    if (SNAPSHOT_ONLY_UNIVERSES.has(universe)) {
      log.info('forced_rescan_redirected_to_snapshot', { universe });
      return serveSnapshotOrEmpty(universe, snapshotUniverse, limit, log);
    }
    log.info('forced_partial_scan');
    return runLiveAndRespond(universe, limit, 'forced-partial', log);
  }

  // Path 2: snapshot-first.
  let snap;
  try {
    snap = await latestSnapshot('target-board', snapshotUniverse);
  } catch (err: any) {
    log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
    snap = null;
  }

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
      tickersScanned: snap.originalResultCount ?? results.length,
      warnings: snap.warnings ?? [],
    });
  }

  // Path 3: stale or missing snapshot.
  if (SNAPSHOT_ONLY_UNIVERSES.has(universe)) {
    // Phase 4h W2 — large universes NEVER inline-scan. If a stale
    // snapshot exists, serve it flagged stale; if no snapshot exists,
    // return an empty-targets response with a clear source code so the
    // UI can show "no scan completed yet" rather than blanking.
    if (snap) {
      log.warn('snapshot_stale_serving_stale', {
        ageMs: snapshotAgeMs(snap),
        budgetMs: snap.freshnessBudgetMs,
      });
      const results = snap.results as any[];
      return json(200, {
        targets: results.slice(0, limit),
        generatedAt: snap.generatedAt,
        source: 'snapshot-stale',
        universe,
        cached: true,
        stale: true,
        ageMs: snapshotAgeMs(snap),
        modelVersion: snap.modelVersion,
        universeSize: snap.universeChecked,
        tickersScanned: snap.originalResultCount ?? results.length,
        warnings: snap.warnings ?? [],
        warning: `snapshot is older than the freshness budget (${Math.round(
          snapshotAgeMs(snap) / 60_000,
        )} min); next scheduled scan will refresh it`,
      });
    }
    log.warn('snapshot_missing_no_inline_scan', { universe: snapshotUniverse });
    return json(200, {
      targets: [],
      generatedAt: new Date().toISOString(),
      source: 'snapshot-missing',
      universe,
      cached: false,
      stale: true,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      universeSize: 0,
      tickersScanned: 0,
      warnings: [],
      warning:
        'no snapshot available yet; the scheduled scan will populate this universe on its next run',
    });
  }

  // Small universes (dow / ndx / core / all) — inline live scan is fine.
  if (snap) {
    log.warn('snapshot_stale', {
      ageMs: snapshotAgeMs(snap),
      budgetMs: snap.freshnessBudgetMs,
    });
  } else {
    log.warn('snapshot_missing', { board: 'target-board', universe: snapshotUniverse });
  }
  return runLiveAndRespond(universe, limit, 'fallback-partial', log);
};

function serveSnapshotOrEmpty(
  universe: TargetUniverseKey,
  snapshotUniverse: UniverseKey,
  limit: number,
  log: ReturnType<typeof logger.child>,
) {
  return (async () => {
    let snap;
    try {
      snap = await latestSnapshot('target-board', snapshotUniverse);
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
      snap = null;
    }
    if (!snap) {
      return json(200, {
        targets: [],
        generatedAt: new Date().toISOString(),
        source: 'snapshot-missing',
        universe,
        cached: false,
        stale: true,
        ageMs: 0,
        modelVersion: MODEL_VERSION,
        universeSize: 0,
        tickersScanned: 0,
        warnings: [],
        warning: 'no snapshot available yet',
      });
    }
    const results = snap.results as any[];
    const ageMs = snapshotAgeMs(snap);
    const stale = !isSnapshotFresh(snap);
    return json(200, {
      targets: results.slice(0, limit),
      generatedAt: snap.generatedAt,
      source: stale ? 'snapshot-stale' : 'snapshot',
      universe,
      cached: true,
      stale,
      ageMs,
      modelVersion: snap.modelVersion,
      universeSize: snap.universeChecked,
      tickersScanned: snap.originalResultCount ?? results.length,
      warnings: snap.warnings ?? [],
    });
  })();
}

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

// Exposed for tests.
export const _internals = { SNAPSHOT_ONLY_UNIVERSES };
