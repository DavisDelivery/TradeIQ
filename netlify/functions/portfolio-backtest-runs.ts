// Phase 4e-1 follow-up — GET /api/portfolio-backtest-runs
//   ?runId=<id>     → single-run status + summary
//   ?window=<label> → list 10 most recent runs for that window
//   (none)          → list 20 most recent runs across all windows
//
// Reads from `portfolioBacktests/{runId}` written by the
// run-portfolio-backtest-background function.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const headers = { 'Content-Type': 'application/json; charset=utf-8' };

export const handler: Handler = async (event) => {
  if (event.httpMethod && event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'method not allowed' }),
    };
  }
  const qs = event.queryStringParameters ?? {};
  const log = logger.child({ fn: 'portfolio-backtest-runs' });

  try {
    const db = getAdminDb();

    if (qs.runId) {
      const doc = await db.collection('portfolioBacktests').doc(qs.runId).get();
      if (!doc.exists) {
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ ok: false, error: 'runId not found' }),
        };
      }
      const includeDetail = qs.detail === '1' || qs.detail === 'true';
      const summary = doc.data();
      let detail: any = null;
      if (includeDetail && summary?.status === 'done') {
        const d = await db
          .collection('portfolioBacktests')
          .doc(qs.runId)
          .collection('detail')
          .doc('full')
          .get();
        if (d.exists) detail = d.data();
      }
      log.info('run_read', { runId: qs.runId, status: summary?.status });
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ok: true, summary, detail }),
      };
    }

    // Composite-index-free: where('window') + orderBy('startedAt') needs a
    // composite index that doesn't exist (live FAILED_PRECONDITION 500,
    // audit 2026-07-15). Over-fetch on the single-field order and filter
    // the window in memory instead.
    const query = db
      .collection('portfolioBacktests')
      .orderBy('startedAt', 'desc')
      .limit(qs.window ? 60 : 20) as FirebaseFirestore.Query;
    const snap = await query.get();
    const runs = snap.docs
      .map((d) => d.data())
      .filter((r: any) => (qs.window ? r.window === qs.window : true))
      .slice(0, qs.window ? 10 : 20);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, runs }),
    };
  } catch (err: any) {
    log.error('list_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};
