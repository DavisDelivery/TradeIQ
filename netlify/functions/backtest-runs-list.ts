// GET /api/backtest-runs?limit=20[&includeIncomplete=1][&status=failed]
//
// Returns the most recent backtest runs (Phase 4a engine output) for the
// run-list view. Each row carries top-level metrics + the survivorship
// stamp so the list can render warning icons without an extra round trip.
//
// Full subcollections (dailyEquity/trades/attribution) are NOT included
// here — they live behind /api/backtest-runs/:runId.
//
// Default behaviour (Phase 4a):
//   - Orders by `completedAt desc`.
//   - Excludes runs without a `completedAt` (failed / pending / running).
//
// Phase 4u W2 — failed-run visibility:
//   - `includeIncomplete=1` switches to `startedAt desc` and includes
//     `failed`, `pending`, and `running` runs.
//   - `status=<value>` filters by status (e.g. `status=failed`); implies
//     `includeIncomplete=1`.
//   - Each row's `error` field is surfaced (null when absent) so a
//     failed run's reason is inspectable without leaving the API.
//
// Response shape:
//   { ok: true, runs: [{
//       runId, config, status, startedAt, completedAt, failedAt, error,
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

// FIX-1 W2 — 'invalid': ran to completion but measured nothing (no PIT
// path / ≥90% null candidates); persisted WITHOUT metrics.
const ALLOWED_STATUSES = ['pending', 'running', 'complete', 'failed', 'invalid'] as const;
type AllowedStatus = (typeof ALLOWED_STATUSES)[number];

const QuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  /** Phase 4u W2 — switch ordering to startedAt and include
   *  failed/pending/running runs. Accepts `1` / `true` / `yes`. */
  includeIncomplete: z
    .string()
    .optional()
    .transform((v) => v === '1' || v === 'true' || v === 'yes'),
  /** Phase 4u W2 — filter by status. Implies includeIncomplete. */
  status: z
    .enum(ALLOWED_STATUSES)
    .optional(),
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
    // Phase 4u W2 — a `status=` filter implies includeIncomplete.
    const includeIncomplete = params.includeIncomplete || params.status !== undefined;
    // Order: completedAt for the default complete-only view (no failed
    // runs ever land in that path); startedAt for the inclusive view
    // (every run has a startedAt — written by the trigger).
    const orderField = includeIncomplete ? 'startedAt' : 'completedAt';
    // Composite-index-free: where('status') + orderBy needs a composite
    // index that doesn't exist (?status= 500'd live; audit 2026-07-15).
    // Over-fetch on the single-field order; the status filter below (which
    // already existed for the no-param path) trims in memory.
    const query = db
      .collection('backtestRuns')
      .orderBy(orderField, 'desc')
      .limit(params.status !== undefined ? params.limit * 4 : params.limit);
    const snap = await query.get();

    const filterStatus: AllowedStatus | undefined = params.status;
    const runs = snap.docs
      .map((d) => {
        const data = d.data();
        return {
          runId: data.runId ?? d.id,
          config: data.config ?? null,
          status: (data.status as AllowedStatus | undefined) ?? 'complete',
          startedAt: data.startedAt ?? null,
          completedAt: data.completedAt ?? null,
          failedAt: data.failedAt ?? null,
          // Phase 4u W2 — surface the engine's failure reason, set by
          // `persistRunFailure`. Null when the run hasn't failed.
          error: typeof data.error === 'string' ? data.error : null,
          metrics: summarizeMetrics(data.metrics),
          universeSurvivorshipCorrected: data.universeSurvivorshipCorrected ?? null,
          benchmark: data.benchmark ?? null,
          warnings: Array.isArray(data.warnings) ? data.warnings : [],
        };
      })
      // Apply the filter in code as well — Firestore may return runs
      // missing the field we ordered by; the where() clause does the
      // server-side work but the extra defensive filter keeps the
      // contract clean.
      .filter((r) => {
        if (filterStatus !== undefined) return r.status === filterStatus;
        if (!includeIncomplete) return r.status === 'complete';
        return true;
      })
      // Trim the over-fetch (status path reads limit*4) back to the
      // requested page size.
      .slice(0, params.limit);

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
