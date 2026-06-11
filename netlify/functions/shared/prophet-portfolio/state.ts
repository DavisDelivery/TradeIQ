// Phase 4e-1 — Portfolio state Firestore CRUD.
//
// Collection layout (one universe per top-level doc):
//
//   prophetPortfolio/{universe}/config/current
//   prophetPortfolio/{universe}/state/current
//   prophetPortfolio/{universe}/swaps/{swapId}
//   prophetPortfolio/{universe}/equityCurve/{YYYY-MM-DD}
//   prophetPortfolio/{universe}/decisionLog/{ticker}_{YYYY-MM-DD}
//
// Reads + writes are thin; transaction guarantees are not used here —
// the rebalance scheduled function (W5) is the only writer of state +
// swaps + decisionLog in a single batch, and that function is gated
// on backtest verdict. Mark-to-market (W6) writes state and an equity
// curve point independently each day.

import { Timestamp } from 'firebase-admin/firestore';
import { getAdminDb } from '../firebase-admin';
import type {
  DecisionLogRow,
  EquityCurvePoint,
  PortfolioConfig,
  PortfolioState,
  PortfolioUniverse,
  SwapEvent,
} from './types';

const ROOT_COLLECTION = 'prophetPortfolio';

function universeDoc(universe: PortfolioUniverse) {
  return getAdminDb().collection(ROOT_COLLECTION).doc(universe);
}

// --- config -----------------------------------------------------------------

export async function getPortfolioConfig(
  universe: PortfolioUniverse,
): Promise<PortfolioConfig | null> {
  const doc = await universeDoc(universe).collection('config').doc('current').get();
  if (!doc.exists) return null;
  return doc.data() as PortfolioConfig;
}

export async function writePortfolioConfig(
  universe: PortfolioUniverse,
  config: PortfolioConfig,
): Promise<void> {
  await universeDoc(universe)
    .collection('config')
    .doc('current')
    .set({ ...config, updatedAt: Timestamp.now() });
}

// --- state ------------------------------------------------------------------

export async function getPortfolioState(
  universe: PortfolioUniverse,
): Promise<PortfolioState | null> {
  const doc = await universeDoc(universe).collection('state').doc('current').get();
  if (!doc.exists) return null;
  const data = doc.data();
  if (!data) return null;
  return {
    universe: data.universe ?? universe,
    asOfDate: data.asOfDate,
    cash: data.cash,
    equity: data.equity,
    positions: Array.isArray(data.positions) ? data.positions : [],
    lastRebalanceAt: data.lastRebalanceAt,
    updatedAt: data.updatedAt,
  } as PortfolioState;
}

export async function writePortfolioState(
  universe: PortfolioUniverse,
  state: PortfolioState,
): Promise<void> {
  await universeDoc(universe)
    .collection('state')
    .doc('current')
    .set({ ...state, universe });
}

// --- swaps ------------------------------------------------------------------

function swapIdFor(asOfDate: string, when: Date = new Date()): string {
  const hh = String(when.getUTCHours()).padStart(2, '0');
  const mm = String(when.getUTCMinutes()).padStart(2, '0');
  return `${asOfDate}-${hh}${mm}`;
}

export async function recordSwap(
  universe: PortfolioUniverse,
  event: Omit<SwapEvent, 'swapId'>,
): Promise<string> {
  const swapId = swapIdFor(event.asOfDate, new Date(event.timestamp));
  await universeDoc(universe)
    .collection('swaps')
    .doc(swapId)
    .set({ ...event, swapId });
  return swapId;
}

export async function listRecentSwaps(
  universe: PortfolioUniverse,
  limit: number = 20,
): Promise<SwapEvent[]> {
  const snap = await universeDoc(universe)
    .collection('swaps')
    .orderBy('timestamp', 'desc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as SwapEvent);
}

// --- equity curve -----------------------------------------------------------

export async function appendEquityCurvePoint(
  universe: PortfolioUniverse,
  point: EquityCurvePoint,
): Promise<void> {
  await universeDoc(universe)
    .collection('equityCurve')
    .doc(point.date)
    .set(point);
}

/** Wave 3A / M9 — duplicate-bar-date guard: the MTM cron reads the point
 *  for the latest bar date before writing; if it already exists the run
 *  is a no-op (holiday/duplicate invocations never write flat points). */
export async function getEquityCurvePoint(
  universe: PortfolioUniverse,
  date: string,
): Promise<EquityCurvePoint | null> {
  const doc = await universeDoc(universe).collection('equityCurve').doc(date).get();
  if (!doc.exists) return null;
  return (doc.data() as EquityCurvePoint) ?? null;
}

export async function listEquityCurve(
  universe: PortfolioUniverse,
  limit: number = 252,
): Promise<EquityCurvePoint[]> {
  const snap = await universeDoc(universe)
    .collection('equityCurve')
    .orderBy('date', 'desc')
    .limit(limit)
    .get();
  // Return ascending so the UI can render directly.
  return snap.docs.map((d) => d.data() as EquityCurvePoint).reverse();
}

// --- decisionLog ------------------------------------------------------------

function decisionLogId(ticker: string, decisionDate: string): string {
  return `${ticker}_${decisionDate}`;
}

export async function writeDecisionLogRow(
  universe: PortfolioUniverse,
  row: DecisionLogRow,
): Promise<void> {
  await universeDoc(universe)
    .collection('decisionLog')
    .doc(decisionLogId(row.ticker, row.decisionDate))
    // Wave 3A / M5: every row carries an explicit fwdReturnsStatus so the
    // populator's equality filter sees it (Firestore equality filters
    // exclude documents missing the field entirely).
    .set({ fwdReturnsStatus: 'pending', ...row });
}

/**
 * Oldest ≤`limit` rows still awaiting forward-return labels.
 *
 * Wave 3A / M5: filters `fwdReturnsStatus == 'pending'` server-side so
 * resolved ('complete') and permanently unresolvable ('exhausted') rows
 * stop occupying the head of the oldest-first window — previously, 200
 * dead rows at the head starved every younger row forever. Requires the
 * composite index (fwdReturnsStatus ASC, decisionDate ASC) declared in
 * firestore.indexes.json. Rows are stamped 'pending' at write time;
 * production decisionLog is empty pre-W5, so no unstamped legacy rows
 * exist to fall outside the filter.
 */
export async function listDecisionLogRowsOlderThan(
  universe: PortfolioUniverse,
  cutoffDate: string,
  limit: number = 200,
): Promise<DecisionLogRow[]> {
  const snap = await universeDoc(universe)
    .collection('decisionLog')
    .where('fwdReturnsStatus', '==', 'pending')
    .where('decisionDate', '<=', cutoffDate)
    .orderBy('decisionDate', 'asc')
    .limit(limit)
    .get();
  return snap.docs.map((d) => d.data() as DecisionLogRow);
}

export async function updateDecisionLogForwardReturns(
  universe: PortfolioUniverse,
  ticker: string,
  decisionDate: string,
  patch: Partial<
    Pick<
      DecisionLogRow,
      | 'forwardReturn30d'
      | 'forwardReturn60d'
      | 'forwardReturn90d'
      | 'fwdReturnsStatus'
      | 'fwdReturnAttempts'
    >
  >,
): Promise<void> {
  await universeDoc(universe)
    .collection('decisionLog')
    .doc(decisionLogId(ticker, decisionDate))
    .set(patch, { merge: true });
}
