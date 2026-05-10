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
}

// Per-board freshness budgets. Intraday signals (price action, breadth) get
// a tight 30-min budget; daily fundamentals/insider get 24h.
export const FRESHNESS_BUDGETS_MS: Record<BoardName, number> = {
  'target-board': 30 * 60_000,
  prophet: 30 * 60_000,
  catalyst: 30 * 60_000,
  williams: 30 * 60_000,
  earnings: 12 * 60 * 60_000,
  insider: 24 * 60 * 60_000,
  lynch: 24 * 60 * 60_000,
};

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
