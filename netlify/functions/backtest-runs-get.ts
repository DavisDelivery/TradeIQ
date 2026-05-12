// GET /api/backtest-runs/:runId
//
// Returns one full backtest run document + summary of its subcollections:
//   - dailyEquity[] — all rows (1700+ for a 7-yr backtest is fine for Recharts)
//   - trades[] — capped at 500 most recent by entryDate (pagination later)
//   - attribution[] — all rows (small; one per (ticker, asOfDate) pair scored)
//   - mlTrainingCount — count only; Phase 5 consumes the full collection
//
// Phase 4b: drives the run detail pane of BacktestView (survivorship banner,
// metrics tiles, equity/drawdown/attribution charts, regime + trades tables).
import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import { withSentry } from './shared/sentry';

const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const TRADES_CAP = 500;

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = withSentry(async (event) => {
  // The redirect rule maps /api/backtest-runs/:runId to this function, so the
  // runId arrives either as a path segment or in `event.path`. Accept either
  // shape so the function works under both rewrite styles.
  const pathParts = (event.path ?? '').split('/').filter(Boolean);
  let runId = pathParts[pathParts.length - 1];
  if (runId === 'backtest-runs-get' || runId === 'backtest-runs') {
    // Direct invoke without runId — accept via querystring as fallback.
    runId = (event.queryStringParameters ?? {}).runId ?? '';
  }

  const log = logger.child({ fn: 'backtest-runs-get', runId });

  if (!runId || !RUN_ID_PATTERN.test(runId)) {
    log.warn('invalid_run_id', { runId });
    return json(400, { ok: false, error: 'missing or invalid runId' });
  }

  try {
    const db = getAdminDb();
    const runRef = db.collection('backtestRuns').doc(runId);

    const [run, equity, trades, attribution, mlCount] = await Promise.all([
      runRef.get(),
      runRef.collection('dailyEquity').orderBy('date', 'asc').get(),
      runRef.collection('trades').orderBy('entryDate', 'asc').limit(TRADES_CAP).get(),
      runRef.collection('attribution').get(),
      runRef.collection('mlTraining').count().get(),
    ]);

    if (!run.exists) {
      log.warn('run_not_found', { runId });
      return json(404, { ok: false, error: 'run not found', runId });
    }

    const runData = run.data() as any;
    const tradesData = trades.docs.map((d) => d.data());
    const tradesTruncated = trades.docs.length === TRADES_CAP;

    log.info('backtest_run_fetched', {
      runId,
      dailyEquityRows: equity.size,
      tradesRows: trades.size,
      tradesTruncated,
      attributionRows: attribution.size,
      mlTrainingCount: mlCount.data().count,
    });

    return json(200, {
      ok: true,
      run: { runId, ...runData },
      dailyEquity: equity.docs.map((d) => d.data()),
      trades: tradesData,
      tradesTruncated,
      attribution: attribution.docs.map((d) => d.data()),
      mlTrainingCount: mlCount.data().count,
    });
  } catch (err: any) {
    log.error('backtest_run_get_failed', { err: String(err?.message ?? err) });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
});
