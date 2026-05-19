// Firestore persistence for backtest runs.
//
// Storage layout:
//   backtestRuns/{runId}
//     - config (BacktestConfig)
//     - status: 'pending' | 'running' | 'complete' | 'failed'
//        - 'pending' (Phase 4b-2): trigger endpoint wrote the row,
//          background function has not started yet.
//        - 'running': background function is actively executing the
//          engine (or, for CLI runs, persistRunStart wrote this on
//          engine entry).
//        - 'complete' / 'failed': terminal states. Once 'complete', the
//          subcollections (dailyEquity/trades/attribution/mlTraining)
//          are fully written.
//     - startedAt, completedAt
//     - metrics (PerformanceMetrics)
//     - universeSurvivorshipCorrected (the stamp Phase 4b UI reads)
//     - warnings
//     - benchmark
//   backtestRuns/{runId}/dailyEquity/{idx}   subcollection
//   backtestRuns/{runId}/trades/{idx}         subcollection
//   backtestRuns/{runId}/attribution/{idx}    subcollection
//   backtestRuns/{runId}/mlTraining/{idx}     subcollection (Phase 5 hook)
//
// Why subcollections: a single backtest can produce thousands of equity
// points, trades, and ML rows. Stuffing all of that in one document
// would push past Firestore's 1MiB doc limit. Subcollections also let
// Phase 4b/5 paginate lazily.

import { getAdminDb } from '../firebase-admin';
import type { Firestore } from 'firebase-admin/firestore';
import type {
  AttributionRecord,
  BacktestConfig,
  BacktestResult,
  DailyEquityPoint,
  MLTrainingRow,
  TradeRecord,
} from './types';

// Test injection seam — same pattern as pit-cache.
let _dbOverride: Firestore | null = null;
export function __setBacktestDbForTesting(db: Firestore | null): void {
  _dbOverride = db;
}
function db(): Firestore {
  return _dbOverride ?? getAdminDb();
}

const COLLECTION = 'backtestRuns';

export function generateRunId(): string {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `bt_${ts}_${rand}`;
}

export async function persistRunStart(
  runId: string,
  config: BacktestConfig,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(runId)
    .set({
      runId,
      config,
      status: 'running',
      startedAt: new Date().toISOString(),
    });
}

/**
 * Phase 4b-2 — write a 'pending' row from the trigger endpoint, before
 * fire-and-forgetting to the background function. The runId is returned
 * synchronously to the launcher so the UI can navigate straight to the
 * run-detail view and start polling. The background function will flip
 * this to 'running' via persistRunRunning() once it begins.
 *
 * Separate from persistRunStart() because:
 *   - CLI runs (scripts/run-backtest.ts) go directly to 'running' (no
 *     queued window — they invoke runBacktest synchronously).
 *   - UI-triggered runs go through 'pending' for the queued window
 *     (typically <1s, but visible in case of background cold-start lag).
 */
export async function persistRunPending(
  runId: string,
  config: BacktestConfig,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(runId)
    .set({
      runId,
      config,
      status: 'pending',
      startedAt: new Date().toISOString(),
    });
}

/**
 * Phase 4b-2 — flip a 'pending' row to 'running' once the background
 * function begins. Uses a merge write so the existing config/startedAt
 * survive.
 */
export async function persistRunRunning(runId: string): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(runId)
    .set({ status: 'running' }, { merge: true });
}

/**
 * Write the final BacktestResult — single-pass path
 * (`scripts/run-backtest.ts` CLI, the in-engine `runBacktest`). Top-
 * level doc gets metrics + warnings; subcollections get the per-event
 * arrays. Batched 500 writes at a time to stay clear of Firestore's
 * batch ceiling. Idempotent on the subcollection writes (same doc
 * IDs).
 *
 * Phase 4u — the bg-function's batched path now streams the per-event
 * arrays to subcollections per batch (via `appendDailyEquityRows`
 * etc.) and calls `persistRunSummary` instead, which writes only the
 * top-level summary. This single-pass function stays as-is for the
 * CLI path which builds the full result in one shot.
 */
export async function persistRunResult(
  runId: string,
  result: BacktestResult,
): Promise<void> {
  await persistRunSummary(runId, result);
  await persistSubcollection<DailyEquityPoint>(
    runId,
    'dailyEquity',
    result.dailyEquity,
  );
  await persistSubcollection<TradeRecord>(runId, 'trades', result.trades);
  await persistSubcollection<AttributionRecord>(
    runId,
    'attribution',
    result.perAnalystAttribution,
  );
}

/**
 * Phase 4u — write only the top-level run summary, no subcollections.
 * Used by the bg-function's terminal batch after the per-array
 * subcollections have already been streamed batch-by-batch. Splitting
 * this out prevents the terminal batch from re-writing potentially
 * thousands of subcollection docs the bg-function already wrote.
 */
export async function persistRunSummary(
  runId: string,
  result: BacktestResult,
): Promise<void> {
  const docRef = db().collection(COLLECTION).doc(runId);
  await docRef.set(
    {
      runId,
      config: result.config,
      status: 'complete',
      completedAt: result.completedAt,
      metrics: result.metrics,
      universeSurvivorshipCorrected: result.universeSurvivorshipCorrected,
      warnings: result.warnings,
      tickerFailures: result.tickerFailures,
      benchmark: result.benchmark,
    },
    { merge: true },
  );
}

export async function persistMLTrainingRows(
  runId: string,
  rows: MLTrainingRow[],
): Promise<void> {
  await persistSubcollection(runId, 'mlTraining', rows);
}

/**
 * Phase 4e-1-infra — append a per-batch slice of mlTraining rows to the
 * subcollection. Used by the checkpoint-and-resume bg-function so each
 * batch's rows land immediately (avoids accumulating them in the cursor
 * doc, which would push past Firestore's 1 MiB limit for full sp500
 * runs).
 *
 * `startIdx` is the cumulative count of rows already persisted across
 * previous batches. New rows are assigned ids startIdx..startIdx+N-1,
 * padded to 8 digits to match the single-pass writer.
 */
export async function appendMLTrainingRows(
  runId: string,
  rows: MLTrainingRow[],
  startIdx: number,
): Promise<void> {
  await appendSubcollection(runId, 'mlTraining', rows, startIdx);
}

/**
 * Phase 4e-1-infra — read back every mlTraining row for a run. Called
 * by the bg-function's terminal batch so `computeMetrics` can compute
 * the information coefficient over the full history (each batch only
 * sees its own rebalances during processing).
 *
 * Returns an empty array if the subcollection is missing.
 */
export async function readAllMLTrainingRows(
  runId: string,
): Promise<MLTrainingRow[]> {
  return readAllSubcollection<MLTrainingRow>(runId, 'mlTraining');
}

/**
 * Phase 4u W1 — same append/read pattern for dailyEquity / trades /
 * attribution / warnings. Pre-4u these arrays were accumulated on
 * `cursor.state` and only written to subcollections at finalize time;
 * the cursor doc grew with the run and eventually blew Firestore's
 * 1 MiB per-doc ceiling (the 2026-05-19 Williams baseline failure).
 * Now each batch streams its slice to the subcollection like mlTraining
 * has done since 4e-1-infra; the cursor carries only a count per array.
 *
 * Ordering note: subcollection ids are zero-padded to 8 digits, so a
 * lexicographic read iterates in insertion order — load-bearing for the
 * dailyEquity arithmetic and attribution windows downstream.
 */
export async function appendDailyEquityRows(
  runId: string,
  rows: DailyEquityPoint[],
  startIdx: number,
): Promise<void> {
  await appendSubcollection(runId, 'dailyEquity', rows, startIdx);
}

export async function readAllDailyEquityRows(
  runId: string,
): Promise<DailyEquityPoint[]> {
  return readAllSubcollection<DailyEquityPoint>(runId, 'dailyEquity');
}

export async function appendTradeRows(
  runId: string,
  rows: TradeRecord[],
  startIdx: number,
): Promise<void> {
  await appendSubcollection(runId, 'trades', rows, startIdx);
}

export async function readAllTradeRows(
  runId: string,
): Promise<TradeRecord[]> {
  return readAllSubcollection<TradeRecord>(runId, 'trades');
}

export async function appendAttributionRows(
  runId: string,
  rows: AttributionRecord[],
  startIdx: number,
): Promise<void> {
  await appendSubcollection(runId, 'attribution', rows, startIdx);
}

export async function readAllAttributionRows(
  runId: string,
): Promise<AttributionRecord[]> {
  return readAllSubcollection<AttributionRecord>(runId, 'attribution');
}

/** Phase 4u — warnings persist as `{ idx, text }` so the read-side
 *  can rebuild the original `string[]` in insertion order. */
interface WarningRow {
  idx: number;
  text: string;
}

export async function appendWarningRows(
  runId: string,
  texts: string[],
  startIdx: number,
): Promise<void> {
  const rows: WarningRow[] = texts.map((text, i) => ({ idx: startIdx + i, text }));
  await appendSubcollection(runId, 'warnings', rows, startIdx);
}

export async function readAllWarningRows(runId: string): Promise<string[]> {
  const rows = await readAllSubcollection<WarningRow>(runId, 'warnings');
  return rows.map((r) => r.text);
}

/** Internal generic — used by every appendXRows above. Chunked at 500
 *  to stay clear of the Firestore batched-write cap. */
async function appendSubcollection<T extends object>(
  runId: string,
  name: string,
  rows: T[],
  startIdx: number,
): Promise<void> {
  if (rows.length === 0) return;
  const colRef = db().collection(COLLECTION).doc(runId).collection(name);
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const batch = db().batch();
    slice.forEach((row, j) => {
      const id = String(startIdx + i + j).padStart(8, '0');
      batch.set(colRef.doc(id), row as unknown as Record<string, unknown>);
    });
    await batch.commit();
  }
}

/** Internal generic — used by every readAllX above. */
async function readAllSubcollection<T>(
  runId: string,
  name: string,
): Promise<T[]> {
  const colRef = db().collection(COLLECTION).doc(runId).collection(name);
  const snap = await colRef.get();
  const rows: T[] = [];
  snap.forEach((doc) => {
    rows.push(doc.data() as T);
  });
  return rows;
}

async function persistSubcollection<T>(
  runId: string,
  name: string,
  items: T[],
): Promise<void> {
  if (items.length === 0) return;
  const colRef = db().collection(COLLECTION).doc(runId).collection(name);
  const CHUNK = 500;
  for (let i = 0; i < items.length; i += CHUNK) {
    const slice = items.slice(i, i + CHUNK);
    const batch = db().batch();
    slice.forEach((item, j) => {
      const id = String(i + j).padStart(8, '0');
      batch.set(colRef.doc(id), item as Record<string, unknown>);
    });
    await batch.commit();
  }
}

export async function persistRunFailure(
  runId: string,
  error: string,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(runId)
    .set(
      {
        status: 'failed',
        failedAt: new Date().toISOString(),
        error,
      },
      { merge: true },
    );
}
