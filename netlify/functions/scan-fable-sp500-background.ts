// FABLE sp500 scan worker — single-pass background function.
//
// Bars-first design keeps the whole sweep inside ONE 15-min background
// window (Phase B Finnhub calls are capped at the gate-passer count), so
// there is deliberately NO cursor/reinvoke chain here. If the budget is
// ever exceeded the snapshot is written status:'partial' and does not
// promote over the last good one (writeSnapshot enforces that).

import type { Handler } from '@netlify/functions';
import { withSentry } from './shared/sentry';
import { logger } from './shared/logger';
import { runFableScan } from './shared/scan-fable';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type BoardSnapshot } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';

const BUDGET_MS = Number(process.env.FABLE_SCAN_BUDGET_MS ?? 12 * 60_000);

export const handler: Handler = withSentry(async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const log = logger.child({ fn: 'scan-fable-sp500-background', universe: 'sp500' });
  const start = Date.now();
  try {
    const res = await runFableScan({ universe: 'sp500', budgetMs: BUDGET_MS, logger: log });
    const overBudget = res.scanDurationMs > BUDGET_MS;
    const snapshot: BoardSnapshot = {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date(start).toISOString(),
      scanDurationMs: res.scanDurationMs,
      universeChecked: res.universeChecked,
      results: res.rows as unknown[],
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.fable,
      warnings: [...res.warnings, `regime:${res.regime}`, `gatePassers:${res.gatePassers}`],
      status: overBudget ? 'partial' : 'complete',
      degraded: res.warnings.some((w) => w.includes('failure-rate-high')),
      ...(res.warnings.length ? { degradedReason: res.warnings.join('; ') } : {}),
    };
    const { snapshotId, promotedToLatest } = await writeSnapshot('fable', 'sp500', snapshot);
    log.info('fable_scan_complete', {
      snapshotId,
      promotedToLatest,
      rows: res.rows.length,
      gatePassers: res.gatePassers,
      regime: res.regime,
      scanDurationMs: res.scanDurationMs,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        snapshotId,
        rows: res.rows.length,
        gatePassers: res.gatePassers,
        regime: res.regime,
      }),
    };
  } catch (err: any) {
    log.error('fable_scan_failed', { err: String(err?.message ?? err) });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }) };
  }
});
