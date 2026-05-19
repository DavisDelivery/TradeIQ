// Phase 4u W1 — per-batch subcollection helpers for the portfolio
// backtest engine.
//
// Mirrors `shared/backtest/persistence.ts`'s mlTraining-style pattern
// for the regular engine. Pre-4u the portfolio cursor accumulated
// equityCurve / swaps / completedHolds / warnings inline on
// `cursor.state`, which would have overflowed Firestore's 1 MiB
// per-doc ceiling for long enough windows (the same defect that hit
// the regular engine — see `reports/phase-4u/diagnosis.md`).
//
// Each batch's slice now lands in `portfolioBacktests/{runId}/<name>/`
// with monotonic, zero-padded ids so a read-all assembles them in
// insertion order.

import type { Firestore } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase-admin';
import type { PortfolioBacktestResult } from './backtest-harness';
import type { SwapEvent } from './types';

const COLLECTION = 'portfolioBacktests';

// Test injection seam — same pattern as scan/backtest persistence.
let _dbOverride: Firestore | null = null;
export function __setPortfolioBacktestDbForTesting(db: Firestore | null): void {
  _dbOverride = db;
}
function db(): Firestore {
  return _dbOverride ?? getAdminDb();
}

type EquityCurvePoint = PortfolioBacktestResult['equityCurve'][number];

export async function appendPortfolioEquityCurveRows(
  runId: string,
  rows: EquityCurvePoint[],
  startIdx: number,
): Promise<void> {
  await appendSubcollection(runId, 'equityCurve', rows, startIdx);
}

export async function readAllPortfolioEquityCurveRows(
  runId: string,
): Promise<EquityCurvePoint[]> {
  return readAllSubcollection<EquityCurvePoint>(runId, 'equityCurve');
}

export async function appendPortfolioSwapRows(
  runId: string,
  rows: SwapEvent[],
  startIdx: number,
): Promise<void> {
  await appendSubcollection(runId, 'swaps', rows, startIdx);
}

export async function readAllPortfolioSwapRows(
  runId: string,
): Promise<SwapEvent[]> {
  return readAllSubcollection<SwapEvent>(runId, 'swaps');
}

interface CompletedHoldRow {
  idx: number;
  holdDays: number;
}

export async function appendPortfolioCompletedHoldRows(
  runId: string,
  holds: number[],
  startIdx: number,
): Promise<void> {
  const rows: CompletedHoldRow[] = holds.map((h, i) => ({ idx: startIdx + i, holdDays: h }));
  await appendSubcollection(runId, 'completedHolds', rows, startIdx);
}

export async function readAllPortfolioCompletedHoldRows(
  runId: string,
): Promise<number[]> {
  const rows = await readAllSubcollection<CompletedHoldRow>(runId, 'completedHolds');
  return rows.map((r) => r.holdDays);
}

interface WarningRow {
  idx: number;
  text: string;
}

export async function appendPortfolioWarningRows(
  runId: string,
  texts: string[],
  startIdx: number,
): Promise<void> {
  const rows: WarningRow[] = texts.map((text, i) => ({ idx: startIdx + i, text }));
  await appendSubcollection(runId, 'warnings', rows, startIdx);
}

export async function readAllPortfolioWarningRows(runId: string): Promise<string[]> {
  const rows = await readAllSubcollection<WarningRow>(runId, 'warnings');
  return rows.map((r) => r.text);
}

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
