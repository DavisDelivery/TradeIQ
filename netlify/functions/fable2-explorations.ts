// GET /api/fable2-explorations[?runId=fbl2_...][&limit=25]
//
// Reader for the FABLE-2 exploration log (collection fable2Explorations).
// List mode returns compact rows (config + metrics, no equity); detail
// mode (?runId=) returns the full doc including the monthly equity curve.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const headers = { 'Content-Type': 'application/json' };
const COLLECTION = 'fable2Explorations';

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'fable2-explorations' });
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'GET only' }) };
  }
  const q = event.queryStringParameters ?? {};
  try {
    const db = getAdminDb();
    if (q.warm === '1') {
      const snap = await db.collection('fable2InsiderWarm').get();
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, progress: snap.docs.map((d) => ({ id: d.id, ...d.data() })) }),
      };
    }
    if (q.holdoutRunId) {
      const snap = await db.collection('fable2Holdout').doc(q.holdoutRunId).get();
      if (!snap.exists) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'not found' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, run: snap.data() }) };
    }
    if (q.runId) {
      const snap = await db.collection(COLLECTION).doc(q.runId).get();
      if (!snap.exists) return { statusCode: 404, headers, body: JSON.stringify({ ok: false, error: 'not found' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, run: snap.data() }) };
    }
    const limit = Math.max(1, Math.min(100, Number(q.limit ?? 25) || 25));
    const snap = await db.collection(COLLECTION).orderBy('startedAt', 'desc').limit(limit).get();
    const runs = snap.docs.map((d) => {
      const { equityMonthly: _e, ...rest } = d.data() as Record<string, unknown>;
      return rest;
    });
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, count: runs.length, runs }) };
  } catch (err: any) {
    log.error('fable2_explorations_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, headers, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
};
