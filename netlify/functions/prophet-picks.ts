// GET /api/prophet-picks
//   ?universe=largecap|russell|all (default largecap)
//   &minConviction=low|medium|high
//   &limit=30
//   &narrate=1|0 (default 1 — narrate top 5 from the snapshot if missing)
//   [&force=1]
//
// Phase 1: snapshot-first. Snapshot stores ALL scored picks. After Phase 4c-1,
// scheduled scans pre-narrate the full pick list before snapshot write, so
// every pick in a fresh snapshot already has a narrative. For older
// snapshots we narrate the top 5 inline so the most-visible picks always
// have a thesis.
//
// Wave 2D (M1) — SNAPSHOT-ONLY, all universes. Every Prophet universe is
// far too large to inline-scan inside a 26s request (largecap ~508,
// russell ~1,930, all ~2,200 names), so this endpoint mirrors
// target-board's #72 reference behavior exactly:
//   - fresh snapshot  → serve it (`source: 'snapshot'`);
//   - stale snapshot  → serve it flagged `stale: true`
//                       (`source: 'snapshot-stale'`) — NEVER inline-scan;
//   - no snapshot     → empty response with `source: 'snapshot-missing'`;
//   - ?force=1        → re-reads the snapshot; the scheduled background
//                       workers are the only thing that rescans.
// Snapshots are produced by the scan-prophet-*-background workers
// (dispatched by the scan-prophet-{largecap,russell,all} crons) and by
// the manual largecap trigger.

import type { Handler } from '@netlify/functions';
import {
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

const NARRATIVE_BUDGET_MS = 3_000;

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

  // Forced rescan in the snapshot-first model = re-read the authoritative
  // latest snapshot (same redirect target-board applies to its
  // snapshot-only universes). A live scan of any Prophet universe cannot
  // finish inside the 26s sync ceiling.
  if (force) log.info('forced_rescan_redirected_to_snapshot', { universe });

  let snap;
  try {
    snap = await latestSnapshot('prophet', snapshotUniverse);
  } catch (err: any) {
    log.error('snapshot_read_failed', { err: String(err?.message ?? err) });
    snap = null;
  }

  if (!snap) {
    log.warn('snapshot_missing_no_inline_scan', { universe: snapshotUniverse });
    return json(200, {
      ok: true,
      universe,
      universeSize: 0,
      partial: false,
      qualified: 0,
      picks: [],
      generatedAt: new Date().toISOString(),
      source: 'snapshot-missing',
      cached: false,
      stale: true,
      ageMs: 0,
      modelVersion: MODEL_VERSION,
      warning:
        'no snapshot available yet; the scheduled scan will populate this universe on its next run',
    });
  }

  const fresh = isSnapshotFresh(snap);
  const ageMs = snapshotAgeMs(snap);
  if (fresh) {
    log.info('snapshot_hit', { ageMs, modelVersion: snap.modelVersion });
  } else {
    log.warn('snapshot_stale_serving_stale', { ageMs, budgetMs: snap.freshnessBudgetMs });
  }

  const all = snap.results as ProphetPick[];
  const filtered = filterProphetByConviction(all, minConviction);
  const sliced = filtered.slice(0, limit);

  // Snapshots written post-4c-1 pre-narrate all picks. For older
  // snapshots written before W4 shipped, we still narrate top-N inline
  // to maintain the previous UX.
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
    source: fresh ? 'snapshot' : 'snapshot-stale',
    cached: true,
    ...(fresh
      ? {}
      : {
          stale: true,
          warning: `snapshot is older than the freshness budget (${Math.round(
            ageMs / 60_000,
          )} min); next scheduled scan will refresh it`,
        }),
    ageMs,
    modelVersion: snap.modelVersion,
    qualified: filtered.length,
    picks: sliced,
    // 4c-2: pass through sieve telemetry so the UI can render the
    // coverage strip (universe → s1 survivors → s2 → final).
    sieve: snap.sieve ?? undefined,
  });
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}
