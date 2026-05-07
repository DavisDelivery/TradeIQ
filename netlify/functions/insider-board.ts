// GET /api/insider-board?days=90&limit=100&index=sp500|all[&force=1]
//
// Phase 1: snapshot-first. See target-board.ts for the full pattern doc.
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
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import type { InsiderBoardResponse, InsiderBoardRow } from './shared/types';

const ALLOWED_WINDOWS = [30, 60, 90, 180] as const;
const SCAN_BUDGET_MS = 22_000;
const LIVE_SCAN_CAP = 80;

const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 30 * 60 * 1000; // daily-cadence board

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

  const snapshotUniverse: UniverseKey | null =
    indexFilter === 'all' ? null : (indexFilter as UniverseKey);

  if (!force && snapshotUniverse) {
    try {
      const snap = await latestSnapshot('insider', snapshotUniverse);
      if (snap && isSnapshotFresh(snap)) {
        const ageMs = snapshotAgeMs(snap);
        log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
        const allRows = snap.results as InsiderBoardRow[];
        // Re-aggregate to the requested narrower window if needed.
        const windowed =
          windowDays === INSIDER_SCHEDULED_WINDOW_DAYS
            ? allRows
            : filterRowsToWindow(allRows, windowDays);
        const trimmed = windowed.slice(0, limit);
        const response: InsiderBoardResponse & {
          source: string;
          ageMs: number;
          modelVersion: string;
        } = {
          rows: trimmed,
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

  return runLiveAndRespond(
    indexFilter,
    windowDays,
    limit,
    force ? 'forced-partial' : 'fallback-partial',
    log,
  );
};

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
