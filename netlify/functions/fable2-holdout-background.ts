// FABLE-2 R3 — THE confirmatory holdout run. ONE SHOT.
//
// POST /.netlify/functions/fable2-holdout-background  Body: { runId }
//
// The config below is FROZEN (reports/fable2/protocol.md APPENDIX A,
// committed 2026-07-14 before this endpoint existed). It is hardcoded
// on purpose: this endpoint accepts NO configuration input, so the
// holdout cannot be explored — only confirmed or refuted.
//
// Single-use guard: if ANY document in `fable2Holdout` has
// status 'complete', this endpoint refuses to run again. A failed
// infra attempt may retry; a completed measurement is FINAL.

import type { Handler } from '@netlify/functions';
import { runPolicyBacktest, type PolicyConfig } from './shared/backtest/policy-engine';
import { loadPolicyInputs } from './shared/backtest/policy-data';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

// FROZEN — do not edit. Matches protocol.md APPENDIX A verbatim.
const FROZEN_CONFIG: PolicyConfig = {
  startDate: '2024-01-01',
  endDate: '2026-06-30',
  initialCapital: 100_000,
  enterPctl: 90,
  exitPctl: 60,
  maxHoldDays: 126,
  stopPct: 0.12,
  slippageBpsPerLeg: 10,
  sizeAlpha: 1.0,
  maxPositionPct: 0.20,
  maxPositions: 15,
  regimeMode: 'none',
};
const UNIVERSE = 'sp500' as const;
const WARMUP_FROM = '2022-06-01';
const COLLECTION = 'fable2Holdout';

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'fable2-holdout-background' });
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  let body: { runId?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid json' }) };
  }
  const runId = body.runId;
  if (!runId || !/^fbl2h_[a-z0-9_]{4,40}$/i.test(runId)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'runId required (fbl2h_...)' }) };
  }

  const db = getAdminDb();

  // --- SINGLE-USE GUARD
  const prior = await db.collection(COLLECTION).where('status', '==', 'complete').limit(1).get();
  if (!prior.empty) {
    const existing = prior.docs[0].id;
    log.warn('holdout_single_use_refused', { existing });
    return {
      statusCode: 409,
      body: JSON.stringify({
        ok: false,
        error: `holdout already measured (${existing}) — the confirmatory run is single-use; the result is FINAL`,
      }),
    };
  }

  const doc = db.collection(COLLECTION).doc(runId);
  await doc.set({
    runId,
    universe: UNIVERSE,
    status: 'running',
    config: FROZEN_CONFIG,
    insiderMode: 'live',
    frozenPer: 'reports/fable2/protocol.md APPENDIX A (2026-07-14)',
    startedAt: new Date().toISOString(),
  });

  try {
    const t0 = Date.now();
    const { inputs, stats } = await loadPolicyInputs({
      universe: UNIVERSE,
      config: FROZEN_CONFIG,
      warmupFrom: WARMUP_FROM,
      concurrency: 8,
      logger: log,
      insiderMode: 'live',
    });
    const loadMs = Date.now() - t0;
    const t1 = Date.now();
    const res = runPolicyBacktest(inputs);
    const simMs = Date.now() - t1;

    const byMonth = new Map<string, { date: string; value: number; spy: number }>();
    for (const row of res.equity) byMonth.set(row.date.slice(0, 7), row);

    await doc.set(
      {
        status: 'complete',
        metrics: res.metrics,
        warnings: res.warnings,
        stats,
        equityMonthly: Array.from(byMonth.values()),
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
    log.info('fable2_holdout_complete', {
      runId,
      totalReturnPct: res.metrics.totalReturnPct,
      excessVsSpyPp: res.metrics.excessVsSpyPp,
      rankIc63: res.metrics.rankIc63,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, runId }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('fable2_holdout_failed', { runId, err: msg });
    await doc.set({ status: 'failed', error: msg, failedAt: new Date().toISOString() }, { merge: true }).catch(() => {});
    return { statusCode: 500, body: JSON.stringify({ ok: false, runId, error: msg }) };
  }
};
