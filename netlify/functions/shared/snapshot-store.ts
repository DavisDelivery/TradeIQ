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
