// Snapshot store — Firestore-backed read/write for board scan results.
//
// Background scheduled functions write the FULL ranked result set here; live
// API endpoints read the latest snapshot and return it directly. This is what
// decouples scan duration (15+ min) from request duration (≤26s).
//
// Layout:
//   boardSnapshots/{board}/runs/{snapshotId}            ← versioned snapshots
//   boardSnapshots/{board}/_latest/{universe}            ← pointer to most recent
//
// snapshotId format: '{universe}-{YYYY-MM-DD-HHmm}' UTC (e.g. 'russell2k-2026-05-07-1430').
//
// CRITICAL: snapshots store the FULL raw result list — never trim before
// writing. Live endpoints can paginate / filter / slice for the response, but
// the stored snapshot is forever the unfiltered output of the analyst battery.
// Phase 4 backtest and Phase 5 calibration depend on this.

import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from './firebase-admin';

export type BoardName =
  | 'target-board'
  | 'prophet'
  | 'catalyst'
  | 'insider'
  | 'williams'
  | 'lynch'
  | 'earnings';

export type UniverseKey =
  | 'sp500'
  | 'ndx'
  | 'dow'
  | 'russell2k'
  | 'all'
  | 'core'
  | 'largecap';

export interface BoardSnapshot {
  /** Stamped from MODEL_VERSION at write time. */
  modelVersion: string;
  /** ISO 8601 UTC timestamp. */
  generatedAt: string;
  /** Wall-clock duration of the scan that produced this snapshot. */
  scanDurationMs: number;
  /** How many tickers the scan considered (full universe size, not survivors). */
  universeChecked: number;
  /** Full raw result set in board-specific shape — never trimmed. */
  results: unknown[];
  /** ms after generatedAt during which this snapshot is considered fresh. */
  freshnessBudgetMs: number;
  /** Optional warnings the scan emitted (rate-limit hits, partial failures). */
  warnings?: string[];
  /** Phase 4o W3 — the scan completed with elevated error/rate-limit
   *  signals. Read endpoints surface this so the UI can render a
   *  "degraded" badge instead of an apparently-clean snapshot. */
  degraded?: boolean;
  /** Phase 4o W3 — when degraded=true, this carries the W3 guard's
   *  human-readable reason (e.g. "8/100 finnhub calls rate-limited"). */
  degradedReason?: string;
  /** 4c-2: sieve metadata for Russell snapshots produced by the 3-stage sieve. */
  sieve?: {
    stage1: { scored: number; survived: number; thresholdScore: number | null; budgetMs: number; partial: boolean };
    stage2: { scored: number; survived: number; thresholdScore: number | null; budgetMs: number; partial: boolean };
    stage3: { scored: number; survived: number; budgetMs: number; partial: boolean };
  };
}

// Per-board freshness budgets. Intraday signals (price action, breadth) get
// a tight 30-min budget; daily fundamentals/insider get 24h.
//
// Phase 4h: target-board widened from 30 min → 26 hours. Russell2k +
// sp500 now scan nightly only (7pm ET = 23:00 UTC). A 30-min budget
// would mark the snapshot stale by ~7:30pm ET — every read for the
// next 23.5 hours would fall into the inline-live-scan path and
// produce the 25-second hang. 26h gives a safe margin past 7pm next
// day and keeps the snapshot "fresh" for the entire inter-scan gap.
export const FRESHNESS_BUDGETS_MS: Record<BoardName, number> = {
  'target-board': 26 * 60 * 60_000,
  prophet: 30 * 60_000,
  catalyst: 30 * 60_000,
  williams: 30 * 60_000,
  earnings: 12 * 60 * 60_000,
  insider: 24 * 60 * 60_000,
  lynch: 24 * 60 * 60_000,
};

// ====================================================================
// Phase 4o W3 — degraded-publish guard
// ====================================================================
//
// The russell2k insider Bug A had its true bite NOT in the rate-limit
// (W1 fixes that) but in the *publish*: a scan that had been silently
// ratelimit-massacred still atomic-swapped its empty result over the
// previous good snapshot. Empty was served as clean. W3 closes that:
// before the terminal writeSnapshot swaps _latest, assess the assembled
// result + the run's accumulated call stats and decide whether the run
// is healthy enough to publish.
//
// The decision is pure — no Firestore in here — so it's trivially
// testable. The caller (the bg-worker's terminal batch) feeds it the
// row count + universe size + call accounting, gets back a policy
// decision: publish / publish-degraded / skip.
//
// Floors are tuned to be sane: the russell2k Bug A pattern (0 rows
// across a 2,000-name universe) clearly trips "skip"; an ordinary low
// yield (8 rows from sp500's 503 names) is fine because most companies
// don't have insider activity in a 180d window. The threshold for
// "skip" is intentionally narrow — we never refuse to publish for low
// yield alone; we only refuse for 0 rows + meaningful universe size,
// or for an error rate so high the data is fundamentally incomplete.

export type PublishAction = 'publish' | 'publish-degraded' | 'skip';

export interface PublishGuardInput {
  /** Assembled row count for this run. */
  resultCount: number;
  /** Universe size at scan start (denominator for "no rows found anywhere"). */
  universeChecked: number;
  /** Phase 4o W1 — count of external-API calls whose retries exhausted on 429. */
  rateLimitedCalls?: number;
  /** Count of external-API calls that returned a non-429 error. */
  errorCalls?: number;
  /** Total external-API calls attempted. Denominator for the error-rate guard. */
  totalCalls?: number;
}

export interface PublishGuardDecision {
  action: PublishAction;
  /** Human-readable reason. Always set for non-'publish' decisions; may
   *  be set for 'publish' if the caller wants to record context. */
  reason?: string;
}

/**
 * Floor for the "0 rows" guard. Universes smaller than this can legitimately
 * return 0 rows (no insider activity in the window), so the empty-result
 * guard only fires for larger universes. Calibrated so sp500/ndx/dow are
 * NOT subject to the empty guard alone — they're protected by the error-rate
 * arm. The russell2k universe (~2,037) trivially clears this.
 */
export const PUBLISH_GUARD_EMPTY_UNIVERSE_MIN = 100;

/** Skip the swap if more than this fraction of API calls failed. */
export const PUBLISH_GUARD_SKIP_ERROR_RATE = 0.5;

/** Mark the snapshot degraded if more than this fraction failed (but less than the skip threshold). */
export const PUBLISH_GUARD_DEGRADED_ERROR_RATE = 0.1;

/**
 * Decide whether to publish the assembled scan result, publish it marked
 * `degraded`, or skip the swap and keep the previous good snapshot.
 *
 * Decision order:
 *   1. resultCount === 0 AND universeChecked >= PUBLISH_GUARD_EMPTY_UNIVERSE_MIN
 *      → skip. This is the russell2k Bug A pattern — a 2,037-name scan
 *      that returns 0 rows is almost certainly rate-limited into oblivion,
 *      not a legitimate "no insider activity anywhere" finding.
 *   2. totalCalls > 0 AND (rateLimited + errors) / totalCalls >= SKIP_ERROR_RATE
 *      → skip. Data is fundamentally incomplete.
 *   3. resultCount === 0 AND ANY rateLimited > 0 → skip. We can't trust
 *      a 0-row result the moment rate-limiting was on the table at all.
 *   4. totalCalls > 0 AND (rateLimited + errors) / totalCalls >= DEGRADED_ERROR_RATE
 *      → publish-degraded. The data is mostly there but the reader should
 *      know not to bet the farm on it.
 *   5. Otherwise → publish.
 */
export function assessSnapshotPublish(input: PublishGuardInput): PublishGuardDecision {
  const totalCalls = input.totalCalls ?? 0;
  const rateLimited = input.rateLimitedCalls ?? 0;
  const errors = input.errorCalls ?? 0;
  const failures = rateLimited + errors;
  const failureRate = totalCalls > 0 ? failures / totalCalls : 0;

  if (
    input.resultCount === 0 &&
    input.universeChecked >= PUBLISH_GUARD_EMPTY_UNIVERSE_MIN
  ) {
    return {
      action: 'skip',
      reason: `empty result over ${input.universeChecked}-ticker universe; refusing to swap _latest`,
    };
  }

  if (totalCalls > 0 && failureRate >= PUBLISH_GUARD_SKIP_ERROR_RATE) {
    return {
      action: 'skip',
      reason: `failure rate ${failures}/${totalCalls} (${(failureRate * 100).toFixed(0)}%) exceeds skip threshold`,
    };
  }

  if (input.resultCount === 0 && rateLimited > 0) {
    return {
      action: 'skip',
      reason: `empty result with ${rateLimited} rate-limited calls; refusing to publish a hollow snapshot`,
    };
  }

  if (totalCalls > 0 && failureRate >= PUBLISH_GUARD_DEGRADED_ERROR_RATE) {
    return {
      action: 'publish-degraded',
      reason: `degraded: ${failures}/${totalCalls} calls failed (${(failureRate * 100).toFixed(0)}%)`,
    };
  }

  return { action: 'publish' };
}

function snapshotIdFor(universe: UniverseKey, when: Date = new Date()): string {
  // YYYY-MM-DD-HHmm in UTC.
  const yyyy = when.getUTCFullYear();
  const mm = String(when.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(when.getUTCDate()).padStart(2, '0');
  const hh = String(when.getUTCHours()).padStart(2, '0');
  const min = String(when.getUTCMinutes()).padStart(2, '0');
  return `${universe}-${yyyy}-${mm}-${dd}-${hh}${min}`;
}

/**
 * Persist a fresh snapshot for a board+universe and update the latest
 * pointer atomically. Old snapshots are kept (Phase 4 backtest reads them).
 */
export async function writeSnapshot(
  board: BoardName,
  universe: UniverseKey,
  snapshot: BoardSnapshot,
): Promise<{ snapshotId: string }> {
  const db = getAdminDb();
  const snapshotId = snapshotIdFor(universe, new Date(snapshot.generatedAt));

  const runDoc = db.collection('boardSnapshots').doc(board).collection('runs').doc(snapshotId);
  const latestDoc = db
    .collection('boardSnapshots')
    .doc(board)
    .collection('_latest')
    .doc(universe);

  await db.runTransaction(async (tx) => {
    tx.set(runDoc, {
      ...snapshot,
      universe,
      board,
      writtenAt: Timestamp.now(),
    });
    tx.set(latestDoc, {
      snapshotId,
      generatedAt: snapshot.generatedAt,
      modelVersion: snapshot.modelVersion,
      universeChecked: snapshot.universeChecked,
      resultsCount: snapshot.results.length,
      writtenAt: Timestamp.now(),
    });
  });

  return { snapshotId };
}

/**
 * Read the most recent snapshot for board+universe. Null if none exists.
 */
export async function latestSnapshot(
  board: BoardName,
  universe: UniverseKey,
): Promise<BoardSnapshot | null> {
  const db = getAdminDb();
  const latestDoc = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('_latest')
    .doc(universe)
    .get();
  if (!latestDoc.exists) return null;
  const { snapshotId } = latestDoc.data() as { snapshotId: string };
  if (!snapshotId) return null;

  const runDoc = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .doc(snapshotId)
    .get();
  if (!runDoc.exists) return null;
  const data = runDoc.data() as BoardSnapshot;
  return data;
}

export function snapshotAgeMs(snapshot: BoardSnapshot, now: number = Date.now()): number {
  return now - new Date(snapshot.generatedAt).getTime();
}

export function isSnapshotFresh(snapshot: BoardSnapshot, now: number = Date.now()): boolean {
  return snapshotAgeMs(snapshot, now) < snapshot.freshnessBudgetMs;
}

/**
 * Phase 4h W1 — retention. After a successful scan publishes a fresh
 * snapshot, prune the universe's `runs/` history to the most recent
 * `keep` docs (default 30) so the collection doesn't grow without
 * limit. The `_latest` pointer is untouched — it's a per-universe doc
 * in `_latest/`, not in `runs/`.
 *
 * Deletes are batched in chunks of 100 (well under Firestore's 500-op
 * batch ceiling) so a one-time backlog of hundreds of stale docs is
 * tractable. Best-effort: if a batch fails the next scan will retry.
 */
export async function pruneOldSnapshots(
  board: BoardName,
  universe: UniverseKey,
  keep: number = 30,
): Promise<{ deleted: number; kept: number }> {
  const db = getAdminDb();
  const all = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .where('universe', '==', universe)
    .orderBy('generatedAt', 'desc')
    .get();

  if (all.size <= keep) return { deleted: 0, kept: all.size };

  const toDelete = all.docs.slice(keep);
  let deleted = 0;
  const CHUNK = 100;
  for (let i = 0; i < toDelete.length; i += CHUNK) {
    const slice = toDelete.slice(i, i + CHUNK);
    const batch = db.batch();
    for (const d of slice) batch.delete(d.ref);
    await batch.commit();
    deleted += slice.length;
  }
  return { deleted, kept: keep };
}

/**
 * Lightweight age summary used by /api/health to expose per-board freshness.
 */
export async function snapshotAgesForBoard(
  board: BoardName,
  universes: UniverseKey[],
): Promise<Record<string, { ageMs: number; generatedAt: string } | null>> {
  const db = getAdminDb();
  const out: Record<string, { ageMs: number; generatedAt: string } | null> = {};
  await Promise.all(
    universes.map(async (u) => {
      const doc = await db
        .collection('boardSnapshots')
        .doc(board)
        .collection('_latest')
        .doc(u)
        .get();
      if (!doc.exists) {
        out[u] = null;
        return;
      }
      const { generatedAt } = doc.data() as { generatedAt: string };
      if (!generatedAt) {
        out[u] = null;
        return;
      }
      out[u] = {
        generatedAt,
        ageMs: Date.now() - new Date(generatedAt).getTime(),
      };
    }),
  );
  return out;
}

// ====================================================================
// History / replay (HistoryView reads through these)
// ====================================================================

export interface SnapshotListItem {
  snapshotId: string;
  generatedAt: string;
  modelVersion: string;
  resultsCount: number;
  universeChecked: number;
}

/**
 * List snapshot IDs for a board+universe, newest first. `limit` caps the
 * number of returned items (default 60, ~2 weeks at 4-snapshot-per-day cadence).
 *
 * Note: snapshot IDs encode the date (YYYY-MM-DD-HHmm), so the firestore-side
 * orderBy on document name is equivalent to orderBy generatedAt.
 */
export async function listSnapshots(
  board: BoardName,
  universe: UniverseKey,
  limit: number = 60,
): Promise<SnapshotListItem[]> {
  const db = getAdminDb();
  const snap = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .where('universe', '==', universe)
    .orderBy('generatedAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((d) => {
    const data = d.data();
    return {
      snapshotId: d.id,
      generatedAt: data.generatedAt,
      modelVersion: data.modelVersion,
      resultsCount: Array.isArray(data.results) ? data.results.length : 0,
      universeChecked: data.universeChecked ?? 0,
    };
  });
}

/**
 * Read a specific historical snapshot by its ID. Used by HistoryView for
 * replay. Null if the ID doesn't exist for this board+universe.
 */
export async function getSnapshotById(
  board: BoardName,
  universe: UniverseKey,
  snapshotId: string,
): Promise<BoardSnapshot | null> {
  const db = getAdminDb();
  const doc = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .doc(snapshotId)
    .get();
  if (!doc.exists) return null;
  const data = doc.data() as BoardSnapshot & { universe?: UniverseKey };
  // Guard against accidental cross-universe pulls (snapshotId could collide if
  // two universes wrote the same minute, though our IDs include universe).
  if (data.universe && data.universe !== universe) return null;
  return data;
}

// ====================================================================
// Point-in-time fallback helpers (Phase 3)
// ====================================================================
//
// When a vendor's API doesn't natively support an "as-of" parameter
// (e.g., Finnhub recommendations carry no per-rating timestamp), we
// fall back to "what we read on the most recent snapshot prior to
// asOfDate." These helpers expose that lookup as a typed read.
//
// Phase 4 backtest reads through these — they are the bridge between
// the live vendor surfaces and the historical record stored in
// boardSnapshots/{board}/runs/.

/**
 * Find the most recent snapshot for (board, universe) generated on or
 * before `asOfDate` (end-of-day UTC, inclusive). Returns null if no
 * such snapshot exists in the store.
 *
 * Used by providers whose vendors don't natively support PIT, so we
 * fall back to "what we read on the most recent prior date."
 *
 * Implementation note: snapshot IDs encode the date as
 * `{universe}-{YYYY-MM-DD-HHmm}`. The Firestore-side orderBy on
 * generatedAt + a `<=` filter is the most reliable path.
 *
 * PIT-cacheable: keyed by (board, universe, asOfDate).
 */
export async function snapshotBeforeDate(
  board: BoardName,
  universe: UniverseKey,
  asOfDate: string,
): Promise<BoardSnapshot | null> {
  const db = getAdminDb();
  // End-of-day UTC ceiling — anything generated up to and including
  // 23:59:59.999 on asOfDate counts as "on or before."
  const cutoffIso = `${asOfDate}T23:59:59.999Z`;
  const snap = await db
    .collection('boardSnapshots')
    .doc(board)
    .collection('runs')
    .where('universe', '==', universe)
    .where('generatedAt', '<=', cutoffIso)
    .orderBy('generatedAt', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  const data = snap.docs[0].data() as BoardSnapshot;
  return data;
}

/**
 * Convenience wrapper: given a per-ticker field name, find the value of
 * that field for `ticker` in the latest snapshot ≤ asOfDate. Returns
 * null if no snapshot exists or the ticker is missing from it.
 *
 * Snapshots store results as `unknown[]` — callers know the shape per
 * board (e.g., catalyst rows have `recommendation`). We type the return
 * with a generic so callers can cast at the call site.
 *
 * PIT-cacheable: keyed by (board, universe, ticker, field, asOfDate).
 */
export async function fieldAtDate<T>(
  board: BoardName,
  universe: UniverseKey,
  ticker: string,
  field: string,
  asOfDate: string,
): Promise<T | null> {
  const snap = await snapshotBeforeDate(board, universe, asOfDate);
  if (!snap) return null;
  const row = (snap.results as any[]).find(
    (r) => r && typeof r === 'object' && r.ticker === ticker,
  );
  if (!row) return null;
  const val = row[field];
  return val === undefined ? null : (val as T);
}
