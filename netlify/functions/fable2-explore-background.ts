// FABLE-2 R2 — exploration runner (background, single invocation).
//
// POST /.netlify/functions/fable2-explore-background
// Body: { runId: string, label?: string, universe?: 'sp500'|'ndx',
//         config?: Partial<PolicyConfig> }
//
// PRE-REGISTERED TRAIN CLAMP (reports/fable2/protocol.md §3, BINDING):
// exploration runs are hard-clamped to endDate ≤ 2023-12-31 and
// startDate ≥ 2018-01-01. The HOLDOUT (2024-01-01 → 2026-06-30) cannot
// be touched by this endpoint AT ALL — the confirmatory run will be a
// separate, single-use endpoint added only after the config is frozen.
//
// Every run — success or failure — writes a doc to `fable2Explorations`
// (no silent discards). The doc carries config, metrics, stats, and a
// monthly-resampled equity curve (small enough for one Firestore doc).

import type { Handler } from '@netlify/functions';
import { runPolicyBacktest, DEFAULT_POLICY_CONFIG, type PolicyConfig } from './shared/backtest/policy-engine';
import { loadPolicyInputs } from './shared/backtest/policy-data';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import type { IndexTag } from './shared/universe';

const TRAIN_START_MIN = '2018-01-01';
const TRAIN_END_MAX = '2023-12-31'; // BINDING clamp — holdout begins 2024-01-01
const WARMUP_FROM = '2016-06-01';
const COLLECTION = 'fable2Explorations';

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'fable2-explore-background' });
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };

  let body: { runId?: string; label?: string; universe?: IndexTag; config?: Partial<PolicyConfig> };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid json' }) };
  }
  const runId = body.runId;
  if (!runId || !/^fbl2_[a-z0-9_]{4,60}$/i.test(runId)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'runId required (fbl2_...)' }) };
  }
  const universe: IndexTag = body.universe === 'ndx' ? 'ndx' : 'sp500';

  // --- Assemble config with the BINDING train clamp.
  const requested: PolicyConfig = { ...DEFAULT_POLICY_CONFIG, ...(body.config ?? {}) };
  const clamped: PolicyConfig = {
    ...requested,
    startDate: requested.startDate < TRAIN_START_MIN ? TRAIN_START_MIN : requested.startDate,
    endDate: requested.endDate > TRAIN_END_MAX ? TRAIN_END_MAX : requested.endDate,
  };
  const clampApplied = clamped.startDate !== requested.startDate || clamped.endDate !== requested.endDate;

  const db = getAdminDb();
  const doc = db.collection(COLLECTION).doc(runId);
  const startedAt = new Date().toISOString();
  await doc.set({
    runId,
    label: body.label ?? null,
    universe,
    status: 'running',
    config: clamped,
    clampApplied,
    startedAt,
  });

  try {
    const t0 = Date.now();
    const { inputs, stats } = await loadPolicyInputs({
      universe,
      config: clamped,
      warmupFrom: WARMUP_FROM,
      concurrency: 8,
      logger: log,
    });
    const loadMs = Date.now() - t0;
    const t1 = Date.now();
    const res = runPolicyBacktest(inputs);
    const simMs = Date.now() - t1;

    // Monthly-resample equity for the doc (daily is too heavy for one doc).
    const byMonth = new Map<string, { date: string; value: number; spy: number }>();
    for (const row of res.equity) byMonth.set(row.date.slice(0, 7), row);
    const equityMonthly = Array.from(byMonth.values());

    await doc.set(
      {
        status: 'complete',
        metrics: res.metrics,
        warnings: res.warnings,
        stats,
        equityMonthly,
        exitReasons: res.trades.reduce<Record<string, number>>((acc, t) => {
          const k = t.exitReason ?? 'open';
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
        timing: { loadMs, simMs },
        completedAt: new Date().toISOString(),
      },
      { merge: true },
    );
    log.info('fable2_explore_complete', {
      runId,
      universe,
      totalReturnPct: res.metrics.totalReturnPct,
      excessVsSpyPp: res.metrics.excessVsSpyPp,
      rankIc63: res.metrics.rankIc63,
      trades: res.metrics.tradeCount,
      loadMs,
      simMs,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, runId }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('fable2_explore_failed', { runId, err: msg });
    await doc
      .set({ status: 'failed', error: msg, failedAt: new Date().toISOString() }, { merge: true })
      .catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ ok: false, runId, error: msg }) };
  }
};
