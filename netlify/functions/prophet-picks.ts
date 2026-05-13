// GET /api/prophet-picks
//   ?universe=largecap|russell|all (default largecap)
//   &minConviction=low|medium|high
//   &limit=30
//   &narrate=1|0 (default 1 — narrate top 5 from snapshot or live result)
//   [&force=1]
//
// Phase 1: snapshot-first. Snapshot stores ALL scored picks. After Phase 4c-1,
// scheduled scans pre-narrate the full pick list before snapshot write, so
// every pick in a fresh snapshot already has a narrative. For older
// snapshots, or for live partial scans, we narrate the top 5 inline so the
// most-visible picks always have a thesis.

import type { Handler } from '@netlify/functions';
import {
  runProphetScan,
  filterProphetByConviction,
  type ProphetUniverseKey,
  type ProphetPick,
} from './shared/scan-prophet';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import { narrateTopN } from './shared/narrative-generator';

const SCAN_BUDGET_MS = 18_000;
const NARRATIVE_BUDGET_MS = 3_000;

// Live partial-scan fallback (in-memory).
const fallbackCache = new Map<string, { data: any; at: number }>();
const FALLBACK_CACHE_TTL_MS = 5 * 60 * 1000;

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const universe = (qs.universe as ProphetUniverseKey) ?? 'largecap';
  const minConviction = (qs.minConviction as 'low' | 'medium' | 'high') ?? 'low';
  const limit = Math.min(Number(qs.limit ?? 30), 100);
  const narrate = qs.narrate !== '0';
  const force = qs.force === '1' || qs.force === 'true';

  const log = logger.child({ fn: 'prophet-picks', universe, force });

  const snapshotUniverse: UniverseKey =
    universe === 'russell' ? 'russell2k' : (universe as UniverseKey);

  if (!force) {
    try {
      const snap = await latestSnapshot('prophet', snapshotUniverse);
      if (snap && isSnapshotFresh(snap)) {
        const ageMs = snapshotAgeMs(snap);
        log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
        const all = snap.results as ProphetPick[];
        const filtered = filterProphetByConviction(all, minConviction);
        const sliced = filtered.slice(0, limit);

        // Snapshots written post-4c-1 pre-narrate all picks. For older
        // snapshots written before W4 shipped, we still narrate top-N
        // inline to maintain the previous UX.
        const needsNarration = sliced.some((p) => !p.narrative);
        if (narrate && needsNarration && process.env.ANTHROPIC_API_KEY) {
          await narrateTopN(sliced, 5, NARRATIVE_BUDGET_MS, (msg, ticker, err) => {
            log.warn(msg, { ticker, err: String((err as any)?.message ?? err) });
          });
        }

        return json(200, {
          ok: true,
          universe,
          universeSize: snap.universeChecked,
          partial: false,
          generatedAt: snap.generatedAt,
          source: 'snapshot',
          cached: true,
          ageMs,
          modelVersion: snap.modelVersion,
          qualified: filtered.length,
          picks: sliced,
        });
      }
      if (snap) log.warn('snapshot_stale', { ageMs: snapshotAgeMs(snap) });
      else log.warn('snapshot_missing');
    } catch (err: any) {
      log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
    }
  }

  return runLiveAndRespond(
    universe,
    minConviction,
    limit,
    narrate,
    force ? 'forced-partial' : 'fallback-partial',
    log,
  );
};

async function runLiveAndRespond(
  universe: ProphetUniverseKey,
  minConviction: 'low' | 'medium' | 'high',
  limit: number,
  narrate: boolean,
  source: 'forced-partial' | 'fallback-partial',
  log: ReturnType<typeof logger.child>,
) {
  const cacheKey = `${universe}|${minConviction}|${source}`;
  if (source === 'fallback-partial') {
    const cached = fallbackCache.get(cacheKey);
    if (cached && Date.now() - cached.at < FALLBACK_CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true, source });
    }
  }

  try {
    // Live scan honors the legacy capped behavior: tighter budget and
    // sufficient-qualified early stop, so it returns inside the 26s window.
    const scan = await runProphetScan({
      universe,
      scanBudgetMs: SCAN_BUDGET_MS,
      concurrency: 7,
      sufficientQualified: limit * 3,
      logger: log,
    });

    const filtered = filterProphetByConviction(scan.picks, minConviction);
    const sliced = filtered.slice(0, limit);

    if (narrate && process.env.ANTHROPIC_API_KEY) {
      await narrateTopN(sliced, 5, NARRATIVE_BUDGET_MS, (msg, ticker, err) => {
        log.warn(msg, { ticker, err: String((err as any)?.message ?? err) });
      });
    }

    const response = {
      ok: true,
      universe,
      universeSize: scan.universeChecked,
      tickersScanned: scan.tickersScanned,
      qualified: filtered.length,
      partial: scan.budgetExceeded,
      regime: scan.regime,
      generatedAt: new Date().toISOString(),
      source,
      cached: false,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      picks: sliced,
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
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
