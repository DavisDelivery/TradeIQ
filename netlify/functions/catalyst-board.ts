// GET /api/catalyst-board
//   ?index=sp500|ndx|dow|russell2k|all
//   &limit=30
//   &filter=cluster|patents|political|contracts|setup|all
//   &minConviction=low|medium|high
//   [&force=1]
//
// Phase 1: snapshot-first. See target-board.ts for the full pattern doc.
// Filter + minConviction are applied at READ time so a single snapshot serves
// every UI permutation without re-scanning.

import type { Handler } from '@netlify/functions';
import {
  runCatalystScan,
  filterCatalystPicks,
  type CatalystUniverseKey,
  type CatalystPick,
} from './shared/scan-catalyst';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';

type Filter = 'cluster' | 'patents' | 'political' | 'contracts' | 'setup' | 'all';
type MinConviction = 'low' | 'medium' | 'high';

const SCAN_BUDGET_MS = 22_000;
const LIVE_SCAN_CAP = 100;

const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

// Large universes NEVER inline-scan (mirrors target-board Phase 4h) — they
// serve the latest snapshot, stale-flagged when past the freshness budget,
// instead of a live partial scan that only reaches a fraction of the universe.
const SNAPSHOT_ONLY_UNIVERSES = new Set<UniverseKey>(['russell2k', 'sp500']);

function catalystSnapshotResponse(
  snap: any,
  filter: Filter,
  minConviction: MinConviction,
  limit: number,
  source: 'snapshot' | 'snapshot-stale',
  ageMs: number,
  stale: boolean,
) {
  const all = snap.results as CatalystPick[];
  const filtered = filterCatalystPicks(all, filter, minConviction);
  return json(200, {
    ok: true,
    picks: filtered.slice(0, limit),
    universeChecked: snap.universeChecked,
    matched: filtered.length,
    filter,
    minConviction,
    cached: true,
    ...(stale ? { stale: true } : {}),
    generatedAt: snap.generatedAt,
    source,
    ageMs,
    modelVersion: snap.modelVersion,
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
  const indexFilter = (qs.index as CatalystUniverseKey) ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 30), 100);
  const filter = (qs.filter as Filter) ?? 'all';
  const minConviction = (qs.minConviction as MinConviction) ?? 'medium';
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({
    fn: 'catalyst-board',
    index: indexFilter,
    filter,
    minConviction,
    force,
  });

  const snapshotUniverse: UniverseKey | null =
    indexFilter === 'all' ? null : (indexFilter as UniverseKey);

  let snap: any = null;
  if (snapshotUniverse) {
    try {
      snap = await latestSnapshot('catalyst', snapshotUniverse);
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
      snap = null;
    }
  }

  if (snap && !force && isSnapshotFresh(snap)) {
    const ageMs = snapshotAgeMs(snap);
    log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
    return catalystSnapshotResponse(snap, filter, minConviction, limit, 'snapshot', ageMs, false);
  }

  if (snapshotUniverse && SNAPSHOT_ONLY_UNIVERSES.has(snapshotUniverse)) {
    if (snap) {
      const ageMs = snapshotAgeMs(snap);
      log.warn('snapshot_stale_serving_stale', { ageMs });
      return catalystSnapshotResponse(snap, filter, minConviction, limit, 'snapshot-stale', ageMs, true);
    }
    log.warn('snapshot_missing_no_inline_scan', { universe: snapshotUniverse });
    return json(200, {
      ok: true,
      picks: [],
      universeChecked: 0,
      matched: 0,
      filter,
      minConviction,
      cached: false,
      generatedAt: new Date().toISOString(),
      source: 'snapshot-missing',
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      warning: 'no snapshot built yet for this universe; next scheduled scan will populate it',
    });
  }

  return runLiveAndRespond(
    indexFilter,
    filter,
    minConviction,
    limit,
    force ? 'forced-partial' : 'fallback-partial',
    log,
  );
};

async function runLiveAndRespond(
  indexFilter: CatalystUniverseKey,
  filter: Filter,
  minConviction: MinConviction,
  limit: number,
  source: 'forced-partial' | 'fallback-partial',
  log: ReturnType<typeof logger.child>,
) {
  const cacheKey = `${indexFilter}|${filter}|${minConviction}|${limit}|${source}`;
  if (source === 'fallback-partial') {
    const cached = fallbackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true, source });
    }
  }

  try {
    const scan = await runCatalystScan({
      universe: indexFilter,
      scanCap: LIVE_SCAN_CAP,
      scanBudgetMs: SCAN_BUDGET_MS,
      concurrency: 8,
      logger: log,
    });

    const filtered = filterCatalystPicks(scan.picks, filter, minConviction);

    const response = {
      ok: true,
      picks: filtered.slice(0, limit),
      universeChecked: scan.universeChecked,
      matched: filtered.length,
      filter,
      minConviction,
      cached: false,
      generatedAt: new Date().toISOString(),
      source,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      warning:
        source === 'fallback-partial'
          ? 'snapshot stale or missing; partial scan'
          : 'forced partial scan',
      warnings: scan.warnings,
    };

    if (source === 'fallback-partial' && filtered.length > 0) {
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
