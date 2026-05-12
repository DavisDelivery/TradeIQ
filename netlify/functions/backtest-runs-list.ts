// GET /api/backtest-runs?limit=20
//
// Lists recent backtest runs from `backtestRuns/{runId}` collection in
// Firestore, sorted by completedAt desc. Returns top-level run metadata +
// summary metrics only — subcollection data (dailyEquity, trades,
// attribution, mlTraining) comes from the detail endpoint.
//
// Phase 4b: drives the run list pane of BacktestView.
import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import { withSentry } from './shared/sentry';

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
  const log = logger.child({ fn: 'backtest-runs-list' });
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Math.max(Number(qs.limit) || 20, 1), 50);

  try {
    const db = getAdminDb();
    const snap = await db
      .collection('backtestRuns')
      .orderBy('completedAt', 'desc')
      .limit(limit)
      .get();

    const runs = snap.docs.map((d) => {
      const data = d.data() as any;
      return {
        runId: data.runId ?? d.id,
        config: data.config ?? null,
        // Top-level metrics only — full subcollections on the detail endpoint.
        metrics: {
          totalReturn: data.metrics?.totalReturn ?? null,
          cagr: data.metrics?.cagr ?? null,
          sharpe: data.metrics?.sharpe ?? null,
          sortino: data.metrics?.sortino ?? null,
          maxDrawdown: data.metrics?.maxDrawdown ?? null,
          winRate: data.metrics?.winRate ?? null,
          ic: data.metrics?.ic ?? null,
          informationRatio: data.metrics?.informationRatio ?? null,
          trades: data.metrics?.trades ?? 0,
        },
        universeSurvivorshipCorrected: data.universeSurvivorshipCorrected ?? null,
        completedAt: data.completedAt ?? null,
        startedAt: data.startedAt ?? null,
        status: data.status ?? 'complete',
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      };
    });

    log.info('backtest_runs_listed', { count: runs.length, limit });
    return json(200, { ok: true, runs, count: runs.length });
  } catch (err: any) {
    log.error('backtest_runs_list_failed', { err: String(err?.message ?? err) });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
});
