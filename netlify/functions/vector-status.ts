// VECTOR — job/collection status probe.
//
// GET /api/vector-status
//
// One call answers: which backfill chains are running/complete/failed
// (vector_scan_state checkpoints with counters + heartbeats), how many
// events/snapshots exist per type, and the latest validation run's state.
// Read-only; exists so the backfill chains are observable without DB
// console access.

import type { Handler } from '@netlify/functions';
import { VECTOR_COLLECTIONS } from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'vector-status' });

export const handler: Handler = async () => {
  try {
    const db = getAdminDb();
    const [stateSnap, uniAgg, e1Agg, e2Agg, e3Agg, runsSnap] = await Promise.all([
      db.collection(VECTOR_COLLECTIONS.scanState).get(),
      db.collection(VECTOR_COLLECTIONS.universeSnapshots).count().get(),
      db.collection(VECTOR_COLLECTIONS.events).where('type', '==', 'E1').count().get(),
      db.collection(VECTOR_COLLECTIONS.events).where('type', '==', 'E2').count().get(),
      db.collection(VECTOR_COLLECTIONS.events).where('type', '==', 'E3').count().get(),
      db.collection(VECTOR_COLLECTIONS.runs).orderBy('startedAt', 'desc').limit(3).get(),
    ]);

    const jobs = stateSnap.docs.map((d) => {
      const cp = d.data() as any;
      return {
        job: d.id,
        status: cp.status,
        invocations: cp.invocations,
        counters: cp.counters,
        cursorSummary: {
          tickerIdx: cp.cursor?.tickerIdx ?? null,
          universeSize: Array.isArray(cp.cursor?.universe) ? cp.cursor.universe.length : null,
          doneThrough: cp.cursor?.doneThrough ?? null,
          phase: cp.cursor?.phase ?? null,
          qIdx: cp.cursor?.qIdx ?? null,
          failedTickers: Array.isArray(cp.cursor?.failedTickers) ? cp.cursor.failedTickers.length : 0,
        },
        startedAt: cp.startedAt,
        heartbeatAt: cp.heartbeatAt,
        completedAt: cp.completedAt ?? null,
        error: cp.error ?? null,
      };
    });

    return {
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
      body: JSON.stringify({
        ok: true,
        jobs,
        collections: {
          universeSnapshots: uniAgg.data().count,
          events: { E1: e1Agg.data().count, E2: e2Agg.data().count, E3: e3Agg.data().count },
        },
        runs: runsSnap.docs.map((d) => ({ runId: d.id, status: (d.data() as any).status, startedAt: (d.data() as any).startedAt })),
        generatedAt: new Date().toISOString(),
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('status_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
