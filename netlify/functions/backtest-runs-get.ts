// GET /api/backtest-runs/:runId
//
// Returns one Phase 4a backtest run + its subcollections:
//   - run        : the top-level doc (config, metrics, survivorship stamp,
//                  warnings, tickerFailures, benchmark)
//   - dailyEquity: full series, sorted by date asc — Recharts handles 1700+
//                  points fine; downsample on the client if >5000
//   - trades     : capped at 500 rows (paginate later if needed)
//   - attribution: full series — typically ~rebalances × topN, well under
//                  any reasonable cap
//   - mlTrainingCount: count only (the rows themselves are Phase 5 fuel,
//                  not Phase 4b UI fuel)
//
// 404 on missing runId; 400 on empty path segment.

import type { Handler } from '@netlify/functions';
import { createLogger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';

const log = createLogger('backtest-runs-get');
const headers = { 'Content-Type': 'application/json' };

function extractRunId(event: { path: string; queryStringParameters?: Record<string, string | undefined> | null }): string | null {
  // Three paths can reach this function:
  //   1. /api/backtest-runs/:runId via the netlify.toml redirect — Netlify's
  //      :runId placeholder lands in queryStringParameters.runId.
  //   2. Direct /.netlify/functions/backtest-runs-get/:runId — the runId
  //      is the trailing path segment.
  //   3. (Defense-in-depth) /api/backtest-runs/start — that path is owned by
  //      the trigger redirect which is listed BEFORE the dynamic :runId
  //      route in netlify.toml. But if redirect ordering ever drifted and
  //      this handler got invoked with runId='start', we'd silently 404
  //      against a non-existent backtestRuns/start document. Explicit
  //      reserved-word reject here means a misconfigured redirect produces
  //      a loud, traceable 400 instead.
  const qsRunId = event.queryStringParameters?.runId;
  if (qsRunId === 'start') return null;
  if (qsRunId) return qsRunId;
  const segments = (event.path || '').split('/').filter(Boolean);
  const last = segments[segments.length - 1];
  // Guard against the bare-function URL where last === 'backtest-runs-get'.
  if (!last || last === 'backtest-runs-get' || last === 'backtest-runs' || last === 'start') return null;
  return last;
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const runId = extractRunId(event as any);
  log.info('request', { runId });

  if (!runId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'missing runId' }),
    };
  }

  try {
    const db = getAdminDb();
    const runRef = db.collection('backtestRuns').doc(runId);

    const [run, equity, trades, attribution, mlCount] = await Promise.all([
      runRef.get(),
      runRef.collection('dailyEquity').orderBy('date', 'asc').get(),
      runRef.collection('trades').orderBy('rebalanceDate', 'asc').limit(500).get(),
      runRef.collection('attribution').get(),
      runRef.collection('mlTraining').count().get(),
    ]);

    if (!run.exists) {
      log.info('response', { status: 404, runId, durationMs: Date.now() - start });
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'run not found', runId }),
      };
    }

    const runData = run.data() ?? {};
    log.info('response', {
      status: 200,
      runId,
      equityCount: equity.size,
      tradeCount: trades.size,
      attributionCount: attribution.size,
      mlCount: mlCount.data().count,
      durationMs: Date.now() - start,
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        run: { runId, ...runData },
        dailyEquity: equity.docs.map((d) => d.data()),
        trades: trades.docs.map((d) => d.data()),
        attribution: attribution.docs.map((d) => d.data()),
        mlTrainingCount: mlCount.data().count,
        generatedAt: new Date().toISOString(),
      }),
    };
  } catch (err: any) {
    log.error('failed', { error: err, runId, durationMs: Date.now() - start });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message ?? err) }),
    };
  }
};
