// GET /api/prophet-picks
//   ?universe=largecap|russell|all (default largecap)
//   &minConviction=low|medium|high
//   &limit=30
//   [&force=1]
//
// Phase 1: snapshot-first. Snapshot stores ALL scored picks.
//
// AI-1 (2026-08-06): picks ship WITHOUT a narrative. Nothing here — and
// nothing in the scheduled scans — calls Claude any more. A thesis is
// generated only when the owner opens a ticker and asks for one.
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


export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const universe = (qs.universe as ProphetUniverseKey) ?? 'largecap';
  const minConviction = (qs.minConviction as 'low' | 'medium' | 'high') ?? 'low';
  const limit = Math.min(Number(qs.limit ?? 30), 100);
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
      universeChecked: 0,
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

  // AI-1 (2026-08-06) — NO inline narration on board load.
  //
  // This used to narrate the top 5 picks whenever the board was fetched, so
  // merely OPENING the Prophet tab spent Claude tokens on tickers the owner
  // might never look at. It was also the sneakier of the two auto-paths:
  // once the scheduled workers stopped pre-narrating, `needsNarration` would
  // have been true on every single load, quietly moving the spend from the
  // cron to the page view rather than removing it.
  //
  // Narration is now exclusively on-demand — the detail panel's "Generate AI
  // thesis" button (useGenerateNarrative -> POST /api/prophet-narrate).

  return json(200, {
    ok: true,
    universe,
    // Wave 4A (M8) — honest coverage. universeSize is the full universe
    // at scan start; universeChecked is the count actually scored
    // (Stage 1's scored count for sieve snapshots — smaller when the
    // stage hit its budget). Pre-Wave-4A snapshots stored the universe
    // size in universeChecked and lack universeSize, so both fall back
    // to the same value there.
    universeSize: snap.universeSize ?? snap.universeChecked,
    universeChecked: snap.universeChecked,
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
