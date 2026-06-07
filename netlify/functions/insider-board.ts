// GET /api/insider-board?days=90&limit=100&index=sp500|all[&force=1]
//
// Phase 1: snapshot-first for a single universe.
// Phase 4l W1: `index=all` now aggregates the four per-universe snapshots
// (sp500 ∪ ndx ∪ dow ∪ russell2k), de-duplicates by ticker, and re-aggregates
// to the requested window — replacing the prior 80-cap live scan. The default
// `all` view is `snapshot-aggregate`; `force=1` keeps a capped live-scan
// escape hatch for debugging.
//
// Snapshots are taken at the widest window (180 days). Live endpoint
// re-filters/re-aggregates to the requested window (30/60/90/180) on read.
// One snapshot per universe covers all 4 window variants.

import type { Handler } from '@netlify/functions';
import {
  runInsiderScan,
  filterRowsToWindow,
  INSIDER_SCHEDULED_WINDOW_DAYS,
  type InsiderUniverseKey,
} from './shared/scan-insider';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type BoardSnapshot,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import type { InsiderBoardResponse, InsiderBoardRow } from './shared/types';

const ALLOWED_WINDOWS = [30, 60, 90, 180] as const;
const SCAN_BUDGET_MS = 22_000;
const LIVE_SCAN_CAP = 80;

// The four per-universe insider snapshots that `index=all` unions.
const AGGREGATE_UNIVERSES: UniverseKey[] = ['sp500', 'ndx', 'dow', 'russell2k'];

const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 30 * 60 * 1000; // daily-cadence board

// Large single universes NEVER inline-scan (mirrors target-board Phase 4h /
// the index=all aggregate path): serve the latest snapshot, stale-flagged
// when past the freshness budget, instead of a capped live scan that only
// reaches ~80 of the universe.
const SNAPSHOT_ONLY_UNIVERSES = new Set<UniverseKey>(['russell2k', 'sp500']);

function insiderSnapshotResponse(
  snap: any,
  windowDays: number,
  limit: number,
  source: 'snapshot' | 'snapshot-stale',
  ageMs: number,
  stale: boolean,
) {
  const allRows = snap.results as InsiderBoardRow[];
  const windowed =
    windowDays === INSIDER_SCHEDULED_WINDOW_DAYS
      ? allRows
      : filterRowsToWindow(allRows, windowDays);
  return json(200, {
    rows: windowed.slice(0, limit),
    universeChecked: snap.universeChecked,
    windowDays,
    generatedAt: snap.generatedAt,
    cached: true,
    ...(stale ? { stale: true } : {}),
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
  const rawDays = Number(qs.days);
  const windowDays: number = (ALLOWED_WINDOWS as readonly number[]).includes(rawDays)
    ? rawDays
    : 90;
  const indexFilter = (qs.index as InsiderUniverseKey) ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 100), 200);
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'insider-board', index: indexFilter, windowDays, force });

  // Single-universe path — unchanged.
  const snapshotUniverse: UniverseKey | null =
    indexFilter === 'all' ? null : (indexFilter as UniverseKey);

  let snap: any = null;
  if (snapshotUniverse) {
    try {
      snap = await latestSnapshot('insider', snapshotUniverse);
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
      snap = null;
    }
  }

  if (snap && !force && isSnapshotFresh(snap)) {
    const ageMs = snapshotAgeMs(snap);
    log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
    return insiderSnapshotResponse(snap, windowDays, limit, 'snapshot', ageMs, false);
  }

  // Large single universes: never live-scan — serve the snapshot (stale-flagged) or empty.
  if (snapshotUniverse && SNAPSHOT_ONLY_UNIVERSES.has(snapshotUniverse)) {
    if (snap) {
      const ageMs = snapshotAgeMs(snap);
      log.warn('snapshot_stale_serving_stale', { ageMs });
      return insiderSnapshotResponse(snap, windowDays, limit, 'snapshot-stale', ageMs, true);
    }
    log.warn('snapshot_missing_no_inline_scan', { universe: snapshotUniverse });
    return json(200, {
      rows: [],
      universeChecked: 0,
      windowDays,
      generatedAt: new Date().toISOString(),
      cached: false,
      source: 'snapshot-missing',
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      warning: 'no snapshot built yet for this universe; next scheduled scan will populate it',
    });
  }

  // `index=all` — snapshot-aggregate path (Phase 4l W1). `force=1` skips
  // this and falls through to a capped live scan (debug escape hatch).
  if (indexFilter === 'all' && !force) {
    try {
      const aggregate = await aggregateAllSnapshots(windowDays, limit, log);
      if (aggregate) return json(200, aggregate);
      log.warn('aggregate_all_no_snapshots');
    } catch (err: any) {
      log.error('aggregate_all_failed', { err: String(err?.message ?? err) });
    }
  }

  return runLiveAndRespond(
    indexFilter,
    windowDays,
    limit,
    force ? 'forced-partial' : 'fallback-partial',
    log,
  );
};

/**
 * Phase 4l W1 — union the four per-universe insider snapshots, de-duplicate
 * by ticker (the indices overlap: Dow ⊂ S&P 500, Nasdaq 100 overlaps S&P 500
 * heavily), re-aggregate to the requested window, sort, trim. Returns null
 * if none of the universes have a stored snapshot at all — in that case the
 * caller falls back to the capped live scan.
 *
 * Graceful partial: if one or more universes are missing/stale but at least
 * one snapshot exists, return the union of the available ones with
 * `partial: true` and the missing universes listed in `missingUniverses`.
 * `generatedAt` is the OLDEST contributing snapshot's timestamp (so freshness
 * is honest); `stale: true` if any contributor is past its freshness budget.
 */
async function aggregateAllSnapshots(
  windowDays: number,
  limit: number,
  log: ReturnType<typeof logger.child>,
): Promise<
  | (InsiderBoardResponse & {
      source: 'snapshot-aggregate';
      ageMs: number;
      modelVersion: string;
      contributingUniverses: UniverseKey[];
      missingUniverses: UniverseKey[];
      staleUniverses: UniverseKey[];
      partial: boolean;
      stale: boolean;
    })
  | null
> {
  const snaps = await Promise.all(
    AGGREGATE_UNIVERSES.map(async (u) => {
      try {
        const snap = await latestSnapshot('insider', u);
        return { universe: u, snap };
      } catch (err: any) {
        log.warn('aggregate_snapshot_read_failed', {
          universe: u,
          err: String(err?.message ?? err),
        });
        return { universe: u, snap: null as BoardSnapshot | null };
      }
    }),
  );

  const contributing: Array<{ universe: UniverseKey; snap: BoardSnapshot }> = [];
  const missing: UniverseKey[] = [];
  const stale: UniverseKey[] = [];
  for (const { universe, snap } of snaps) {
    if (!snap) {
      missing.push(universe);
      continue;
    }
    contributing.push({ universe, snap });
    if (!isSnapshotFresh(snap)) stale.push(universe);
  }

  if (contributing.length === 0) return null;

  // De-dup by ticker. Indices overlap; the same ticker appears in 2–4
  // snapshots. Prefer the freshest contributing snapshot's row — same data
  // by construction (all four scans run the same window over the same
  // Finnhub feed), but if one universe wrote a more recent snapshot than
  // another, its row is the freshest read of that ticker.
  const sortedByFreshness = [...contributing].sort(
    (a, b) =>
      new Date(b.snap.generatedAt).getTime() -
      new Date(a.snap.generatedAt).getTime(),
  );
  const merged = new Map<string, InsiderBoardRow>();
  let universeUnion = 0;
  for (const { snap } of sortedByFreshness) {
    universeUnion += snap.universeChecked;
    const rows = snap.results as InsiderBoardRow[];
    for (const row of rows) {
      if (!row || typeof row.ticker !== 'string') continue;
      if (merged.has(row.ticker)) continue; // first-seen wins → freshest
      merged.set(row.ticker, row);
    }
  }

  const unionRows = Array.from(merged.values());
  const windowed =
    windowDays === INSIDER_SCHEDULED_WINDOW_DAYS
      ? unionRows
      : filterRowsToWindow(unionRows, windowDays);
  const trimmed = windowed.slice(0, limit);

  // Honest freshness: the aggregate is only as fresh as its oldest input.
  const oldest = contributing.reduce((acc, c) =>
    new Date(c.snap.generatedAt).getTime() <
    new Date(acc.snap.generatedAt).getTime()
      ? c
      : acc,
  );
  const ageMs = snapshotAgeMs(oldest.snap);

  log.info('aggregate_all_complete', {
    contributing: contributing.map((c) => c.universe),
    missing,
    staleUniverses: stale,
    unionRows: unionRows.length,
    windowed: windowed.length,
    trimmed: trimmed.length,
    oldestUniverse: oldest.universe,
    ageMs,
  });

  return {
    rows: trimmed,
    universeChecked: universeUnion,
    windowDays,
    generatedAt: oldest.snap.generatedAt,
    cached: true,
    source: 'snapshot-aggregate',
    ageMs,
    modelVersion: oldest.snap.modelVersion,
    contributingUniverses: contributing.map((c) => c.universe),
    missingUniverses: missing,
    staleUniverses: stale,
    partial: missing.length > 0 || stale.length > 0,
    stale: stale.length > 0,
  };
}

async function runLiveAndRespond(
  indexFilter: InsiderUniverseKey,
  windowDays: number,
  limit: number,
  source: 'forced-partial' | 'fallback-partial',
  log: ReturnType<typeof logger.child>,
) {
  const cacheKey = `${indexFilter}|${windowDays}|${limit}|${source}`;
  if (source === 'fallback-partial') {
    const cached = fallbackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true, source });
    }
  }

  try {
    const scan = await runInsiderScan({
      universe: indexFilter,
      windowDays,
      scanCap: LIVE_SCAN_CAP,
      scanBudgetMs: SCAN_BUDGET_MS,
      concurrency: 8,
      // Live (capped) path skips role enrichment — it's expensive and
      // the snapshot path already has it.
      enrichRoles: false,
      logger: log,
    });

    const trimmed = scan.rows.slice(0, limit);

    const response = {
      rows: trimmed,
      universeChecked: scan.universeChecked,
      windowDays,
      generatedAt: new Date().toISOString(),
      cached: false,
      source,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      warning:
        source === 'fallback-partial'
          ? 'snapshot stale or missing; partial scan (no role enrichment)'
          : 'forced partial scan (no role enrichment)',
      warnings: scan.warnings,
    };

    if (source === 'fallback-partial' && trimmed.length > 0) {
      fallbackCache.set(cacheKey, { data: response, at: Date.now() });
    }
    return json(200, response);
  } catch (err: any) {
    log.error('live_scan_failed', { err: String(err?.message ?? err) });
    return json(500, { error: String(err?.message ?? err) });
  }
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
    body: JSON.stringify(body),
  };
}
