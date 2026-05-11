// Firestore persistence for backtest runs.
//
// Storage layout:
//   backtestRuns/{runId}
//     - config (BacktestConfig)
//     - status: 'running' | 'complete' | 'failed'
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
 * Write the final BacktestResult: top-level doc gets metrics + warnings,
 * subcollections get the per-event arrays. Batched 500 writes at a time
 * to stay clear of Firestore's batch ceiling.
 */
export async function persistRunResult(
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
      benchmark: result.benchmark,
    },
    { merge: true },
  );

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

export async function persistMLTrainingRows(
  runId: string,
  rows: MLTrainingRow[],
): Promise<void> {
  await persistSubcollection(runId, 'mlTraining', rows);
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
