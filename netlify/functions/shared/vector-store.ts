// VECTOR — Firestore store + checkpoint helpers.
//
// Collections (all under the app's default Firestore project):
//   vector_events             — one doc per event, deterministic id
//                               `${type}_${ticker}_${date}` so backfill
//                               re-runs are idempotent upserts.
//   vector_universe_snapshots — month-end PIT hygiene lists (delisted
//                               included), id `YYYY-MM-DD`.
//   vector_scan_state         — one doc per long job (checkpoint cursor).
//   vector_runs               — validation/backtest run docs + run log.
//   vector_13f_agg            — quarterly holder aggregates per ticker,
//                               id `${ticker}_${filedQuarter}`.
//
// Checkpoint discipline (4t-W1c): failures THROW and the job re-enters
// via its checkpoint — an error path never writes an empty result. The
// checkpoint doc carries a heartbeat so the recovery sweep can fail out
// zombies (startedAt old + no heartbeat) instead of leaving them
// 'running' forever.

import { getAdminDb } from './firebase-admin';

export const VECTOR_COLLECTIONS = {
  events: 'vector_events',
  universeSnapshots: 'vector_universe_snapshots',
  scanState: 'vector_scan_state',
  runs: 'vector_runs',
  agg13f: 'vector_13f_agg',
} as const;

export type VectorEventType = 'E1' | 'E2' | 'E3';

export interface VectorEventDoc {
  id: string;
  type: VectorEventType;
  ticker: string;
  /** YYYY-MM-DD event day d (trading day the info is public) */
  date: string;
  /** event-type-specific payload (sue/reaction/volumeShock, cluster, 13d) */
  payload: Record<string, unknown>;
  /** state features at t (nulls carry _noData semantics) */
  features: Record<string, unknown>;
  sizeBucket: 'LARGE' | 'MID' | 'SMALL';
  sector: string | null;
  /** whether the E1 live-display trigger ("agreement") fired */
  agreement?: boolean;
  modelVersion: string;
  createdAt: string;
}

export function eventDocId(type: VectorEventType, ticker: string, date: string): string {
  return `${type}_${ticker}_${date}`;
}

export async function upsertEvents(events: VectorEventDoc[]): Promise<number> {
  const db = getAdminDb();
  // Firestore batch cap is 500; chunk.
  let written = 0;
  for (let i = 0; i < events.length; i += 450) {
    const batch = db.batch();
    for (const e of events.slice(i, i + 450)) {
      batch.set(db.collection(VECTOR_COLLECTIONS.events).doc(e.id), e, { merge: true });
    }
    await batch.commit();
    written += Math.min(450, events.length - i);
  }
  return written;
}

// ---------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------

export interface VectorCheckpoint {
  job: string;
  status: 'running' | 'complete' | 'failed';
  /** job-specific cursor (e.g. next month-end, next ticker index) */
  cursor: Record<string, unknown>;
  /** accumulated counters, merged across invocations */
  counters: Record<string, number>;
  startedAt: string;
  heartbeatAt: string;
  completedAt?: string;
  error?: string;
  invocations: number;
}

export async function readCheckpoint(job: string): Promise<VectorCheckpoint | null> {
  const snap = await getAdminDb().collection(VECTOR_COLLECTIONS.scanState).doc(job).get();
  return snap.exists ? (snap.data() as VectorCheckpoint) : null;
}

export async function writeCheckpoint(cp: VectorCheckpoint): Promise<void> {
  await getAdminDb().collection(VECTOR_COLLECTIONS.scanState).doc(cp.job).set(cp, { merge: true });
}

export async function heartbeat(job: string): Promise<void> {
  await getAdminDb()
    .collection(VECTOR_COLLECTIONS.scanState)
    .doc(job)
    .set({ heartbeatAt: new Date().toISOString() }, { merge: true });
}

/** Zombie fail-out: running + heartbeat older than staleMs => failed. */
export async function failOutZombies(staleMs = 30 * 60_000): Promise<string[]> {
  const db = getAdminDb();
  const q = await db
    .collection(VECTOR_COLLECTIONS.scanState)
    .where('status', '==', 'running')
    .get();
  const failed: string[] = [];
  const cutoff = Date.now() - staleMs;
  for (const doc of q.docs) {
    const cp = doc.data() as VectorCheckpoint;
    if (Date.parse(cp.heartbeatAt ?? cp.startedAt) < cutoff) {
      await doc.ref.set(
        { status: 'failed', error: `zombie: no heartbeat since ${cp.heartbeatAt}` },
        { merge: true },
      );
      failed.push(cp.job);
    }
  }
  return failed;
}

// ---------------------------------------------------------------------
// Self-reinvoke (checkpoint-resume chain) — same shape the dead-cron
// remediation workers use: fire-and-forget POST to our own function URL.
// ---------------------------------------------------------------------

export function selfUrl(functionName: string): string {
  const base =
    process.env.URL ??
    process.env.DEPLOY_PRIME_URL ??
    'https://tradeiq-alpha.netlify.app';
  return `${base}/.netlify/functions/${functionName}`;
}

export async function reinvoke(functionName: string, body: Record<string, unknown>): Promise<void> {
  // Deliberately not awaited to completion — background functions return
  // 202 immediately. Any network error here surfaces as a missing next
  // link in the chain, which the zombie sweep converts into 'failed'.
  await fetch(selfUrl(functionName), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
