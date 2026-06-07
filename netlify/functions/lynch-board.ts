// GET /api/lynch-board?index=sp500&limit=30&minConfidence=0.5[&force=1]

import type { Handler } from '@netlify/functions';
import { runLynchScan, type LynchUniverseKey } from './shared/scan-lynch';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';

const SCAN_BUDGET_MS = 24_000;
const LIVE_SCAN_CAP = 150;

const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

// Large universes NEVER inline-scan (mirrors target-board Phase 4h) — they
// serve the latest snapshot, stale-flagged when past the freshness budget,
// instead of a live partial scan that only reaches a fraction of the universe.
const SNAPSHOT_ONLY_UNIVERSES = new Set<UniverseKey>(['russell2k', 'sp500']);

function lynchSnapshotResponse(
  snap: any,
  indexFilter: LynchUniverseKey,
  minConfidence: number,
  limit: number,
  source: 'snapshot' | 'snapshot-stale',
  ageMs: number,
  stale: boolean,
) {
  const all = snap.results as any[];
  const filtered = all.filter((r) => r.confidence >= minConfidence);
  return json(200, {
    ok: true,
    index: indexFilter,
    generatedAt: snap.generatedAt,
    source,
    cached: true,
    ...(stale ? { stale: true } : {}),
    ageMs,
    modelVersion: snap.modelVersion,
    universeSize: snap.universeChecked,
    scanned: snap.universeChecked ?? all.length,
    scored: filtered.length,
    count: Math.min(limit, filtered.length),
    candidates: filtered.slice(0, limit),
    ...(stale
      ? {
          warning: `snapshot is older than the freshness budget (${Math.round(
            ageMs / 60_000,
          )} min); next scheduled scan will refresh it`,
        }
      : {}),
  });
}

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const indexFilter = (qs.index as LynchUniverseKey) ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 25), 100);
  const minConfidence = Number(qs.minConfidence ?? 0.5);
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'lynch-board', index: indexFilter, force });

  const snapshotUniverse: UniverseKey | null =
    indexFilter === 'all' ? null : (indexFilter as UniverseKey);

  let snap: any = null;
  if (snapshotUniverse) {
    try {
      snap = await latestSnapshot('lynch', snapshotUniverse);
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
      snap = null;
    }
  }

  if (snap && !force && isSnapshotFresh(snap)) {
    const ageMs = snapshotAgeMs(snap);
    log.info('snapshot_hit', { ageMs });
    return lynchSnapshotResponse(snap, indexFilter, minConfidence, limit, 'snapshot', ageMs, false);
  }

  if (snapshotUniverse && SNAPSHOT_ONLY_UNIVERSES.has(snapshotUniverse)) {
    if (snap) {
      const ageMs = snapshotAgeMs(snap);
      log.warn('snapshot_stale_serving_stale', { ageMs });
      return lynchSnapshotResponse(snap, indexFilter, minConfidence, limit, 'snapshot-stale', ageMs, true);
    }
    log.warn('snapshot_missing_no_inline_scan', { universe: snapshotUniverse });
    return json(200, {
      ok: true,
      index: indexFilter,
      generatedAt: new Date().toISOString(),
      source: 'snapshot-missing',
      cached: false,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      universeSize: 0,
      scanned: 0,
      scored: 0,
      count: 0,
      candidates: [],
      warning: 'no snapshot built yet for this universe; next scheduled scan will populate it',
    });
  }

  return runLiveAndRespond(
    indexFilter,
    minConfidence,
    limit,
    force ? 'forced-partial' : 'fallback-partial',
    log,
  );
};

async function runLiveAndRespond(
  indexFilter: LynchUniverseKey,
  minConfidence: number,
  limit: number,
  source: 'forced-partial' | 'fallback-partial',
  log: ReturnType<typeof logger.child>,
) {
  const cacheKey = `${indexFilter}:${minConfidence}:${source}`;
  if (source === 'fallback-partial') {
    const cached = fallbackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true, source });
    }
  }

  try {
    const scan = await runLynchScan({
      universe: indexFilter,
      scanCap: LIVE_SCAN_CAP,
      scanBudgetMs: SCAN_BUDGET_MS,
      concurrency: 8,
      minConfidence,
      logger: log,
    });

    const response = {
      ok: true,
      index: indexFilter,
      generatedAt: new Date().toISOString(),
      source,
      cached: false,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      universeSize: scan.universeChecked,
      scanned: scan.scanned,
      scored: scan.candidates.length,
      count: Math.min(limit, scan.candidates.length),
      candidates: scan.candidates.slice(0, limit),
      warning:
        source === 'fallback-partial'
          ? 'snapshot stale or missing; partial scan'
          : 'forced partial scan',
      warnings: scan.warnings,
    };

    if (source === 'fallback-partial' && scan.candidates.length > 0) {
      fallbackCache.set(cacheKey, { data: response, at: Date.now() });
    }
    return json(200, response);
  } catch (err: any) {
    log.error('live_scan_failed', { err: String(err?.message ?? err) });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
    body: JSON.stringify(body),
  };
}
