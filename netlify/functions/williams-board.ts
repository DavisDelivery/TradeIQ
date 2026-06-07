// GET /api/williams-board?index=sp500&side=both&limit=30[&force=1]
//
// Phase 1: snapshot-first. See target-board.ts for the full pattern doc.

import type { Handler } from '@netlify/functions';
import {
  runWilliamsScan,
  type WilliamsUniverseKey,
} from './shared/scan-williams';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';

const SCAN_BUDGET_MS = 24_000;
const LIVE_SCAN_CAP = 200;

const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

// Large universes NEVER inline-scan (mirrors target-board Phase 4h): a live
// partial scan only reaches ~200 of the 1928-name Russell before its budget
// and mislabels coverage. These always serve the latest snapshot, stale-
// flagged when past the freshness budget (e.g. a weekday-only scan over a
// weekend), instead of falling into runLiveAndRespond.
const SNAPSHOT_ONLY_UNIVERSES = new Set<UniverseKey>(['russell2k', 'sp500']);

function williamsSnapshotResponse(
  snap: any,
  indexFilter: WilliamsUniverseKey,
  side: 'long' | 'short' | 'both',
  limit: number,
  source: 'snapshot' | 'snapshot-stale',
  ageMs: number,
  stale: boolean,
) {
  const all = snap.results as any[];
  const filtered = side === 'both' ? all : all.filter((r) => r.side === side);
  return json(200, {
    ok: true,
    index: indexFilter,
    side,
    generatedAt: snap.generatedAt,
    source,
    cached: true,
    ...(stale ? { stale: true } : {}),
    ageMs,
    modelVersion: snap.modelVersion,
    universeSize: snap.universeChecked,
    scanned: snap.universeChecked ?? all.length,
    scored: all.length,
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
  const indexFilter = (qs.index as WilliamsUniverseKey) ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 25), 100);
  const side = (qs.side as 'long' | 'short' | 'both') ?? 'both';
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'williams-board', index: indexFilter, force });

  // 'all' isn't a valid snapshot universe key; only board-specific indexes are.
  const snapshotUniverse: UniverseKey | null =
    indexFilter === 'all' ? null : (indexFilter as UniverseKey);

  let snap: any = null;
  if (snapshotUniverse) {
    try {
      snap = await latestSnapshot('williams', snapshotUniverse);
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
      snap = null;
    }
  }

  // Fresh snapshot (non-forced).
  if (snap && !force && isSnapshotFresh(snap)) {
    const ageMs = snapshotAgeMs(snap);
    log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
    return williamsSnapshotResponse(snap, indexFilter, side, limit, 'snapshot', ageMs, false);
  }

  // Large universes: never live-scan — serve the snapshot (stale-flagged) or empty.
  if (snapshotUniverse && SNAPSHOT_ONLY_UNIVERSES.has(snapshotUniverse)) {
    if (snap) {
      const ageMs = snapshotAgeMs(snap);
      log.warn('snapshot_stale_serving_stale', { ageMs });
      return williamsSnapshotResponse(snap, indexFilter, side, limit, 'snapshot-stale', ageMs, true);
    }
    log.warn('snapshot_missing_no_inline_scan', { universe: snapshotUniverse });
    return json(200, {
      ok: true,
      index: indexFilter,
      side,
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

  return runLiveAndRespond(indexFilter, side, limit, force ? 'forced-partial' : 'fallback-partial', log);
};

async function runLiveAndRespond(
  indexFilter: WilliamsUniverseKey,
  side: 'long' | 'short' | 'both',
  limit: number,
  source: 'forced-partial' | 'fallback-partial',
  log: ReturnType<typeof logger.child>,
) {
  const cacheKey = `${indexFilter}:${side}:${source}`;
  if (source === 'fallback-partial') {
    const cached = fallbackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true, source });
    }
  }

  try {
    const scan = await runWilliamsScan({
      universe: indexFilter,
      scanCap: LIVE_SCAN_CAP,
      scanBudgetMs: SCAN_BUDGET_MS,
      concurrency: 10,
      logger: log,
    });

    const filtered =
      side === 'both' ? scan.candidates : scan.candidates.filter((r) => r.side === side);

    const response = {
      ok: true,
      index: indexFilter,
      side,
      generatedAt: new Date().toISOString(),
      source,
      cached: false,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      universeSize: scan.universeChecked,
      scanned: scan.scanned,
      scored: scan.candidates.length,
      count: Math.min(limit, filtered.length),
      candidates: filtered.slice(0, limit),
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
