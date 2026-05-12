// GET /api/backtest-runs?limit=20
//
// Returns the most recent backtest runs (Phase 4a engine output) for the
// run-list view. Each row carries top-level metrics + the survivorship
// stamp so the list can render warning icons without an extra round trip.
//
// Full subcollections (dailyEquity/trades/attribution) are NOT included
// here — they live behind /api/backtest-runs/:runId.
//
// Response shape:
//   { ok: true, runs: [{
//       runId, config, status, completedAt,
//       metrics: { totalReturnPct, cagrPct, sharpe, maxDrawdownPct,
//                  winRatePct, informationCoefficient, informationRatio,
//                  tradeCount },
//       universeSurvivorshipCorrected: { universe, corrected, coverageThrough },
//       benchmark: { ticker, totalReturnPct } | null,
//       warnings: string[],
//     }, ...] }

import type { Handler } from '@netlify/functions';
import { z } from 'zod';
import { createLogger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';

const log = createLogger('backtest-runs-list');
const headers = { 'Content-Type': 'application/json' };

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

function summarizeMetrics(m: any): Record<string, number | null> {
  // Defensive: persistence writes the full PerformanceMetrics object, but
  // we only echo the seven fields the list view actually renders.
  if (!m || typeof m !== 'object') {
    return {
      totalReturnPct: null,
      cagrPct: null,
      sharpe: null,
      maxDrawdownPct: null,
      winRatePct: null,
      informationCoefficient: null,
      informationRatio: null,
      tradeCount: null,
    };
  }
  return {
    totalReturnPct: m.totalReturnPct ?? null,
    cagrPct: m.cagrPct ?? null,
    sharpe: m.sharpe ?? null,
    maxDrawdownPct: m.maxDrawdownPct ?? null,
    winRatePct: m.winRatePct ?? null,
    informationCoefficient: m.informationCoefficient ?? null,
    informationRatio: m.informationRatio ?? null,
    tradeCount: m.tradeCount ?? null,
  };
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  log.info('request', { qs: event.queryStringParameters });
  try {
    const params = QuerySchema.parse(event.queryStringParameters ?? {});
    const db = getAdminDb();
    // Note: order by completedAt desc. Runs that never completed (running /
    // failed) have no completedAt and won't appear here — that's intentional
    // for now; a Phase 4b-2 launcher view will surface in-flight runs.
    const snap = await db
      .collection('backtestRuns')
      .orderBy('completedAt', 'desc')
      .limit(params.limit)
      .get();

    const runs = snap.docs.map((d) => {
      const data = d.data();
      return {
        runId: data.runId ?? d.id,
        config: data.config ?? null,
        status: data.status ?? 'complete',
        completedAt: data.completedAt ?? null,
        metrics: summarizeMetrics(data.metrics),
        universeSurvivorshipCorrected: data.universeSurvivorshipCorrected ?? null,
        benchmark: data.benchmark ?? null,
        warnings: Array.isArray(data.warnings) ? data.warnings : [],
      };
    });

    log.info('response', {
      status: 200,
      count: runs.length,
      durationMs: Date.now() - start,
    });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        runs,
        generatedAt: new Date().toISOString(),
      }),
    };
  } catch (err: any) {
    log.error('failed', { error: err, durationMs: Date.now() - start });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: String(err?.message ?? err) }),
    };
  }
};
