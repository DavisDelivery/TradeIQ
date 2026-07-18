// TRIDENT russell2k scan — background worker. The two-stage shape inside
// runTridentScan (bars-only gate first) makes the 1,900-name universe fit
// one container: stage 1 kills ~2/3 before any Finnhub/Massive call and
// stage 2 rides warm provider-live-cache entries.

import type { Handler } from '@netlify/functions';
import { runTridentScan } from './shared/trident/scan-trident';
import {
  writeSnapshot,
  assessSnapshotPublish,
  FRESHNESS_BUDGETS_MS,
} from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 13 * 60_000;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'scan-trident-russell2k-background', universe: 'russell2k' });
  const started = Date.now();
  try {
    const scan = await runTridentScan({
      universe: 'russell2k',
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      concurrency: 8,
      logger: log,
    });

    let status: 'complete' | 'partial' = scan.partial ? 'partial' : 'complete';
    const warnings = [...scan.warnings];
    if (status === 'complete') {
      const decision = assessSnapshotPublish({
        resultCount: scan.rows.length,
        universeChecked: scan.universeChecked,
      });
      if (decision.action === 'skip') {
        status = 'partial';
        warnings.push(`publish guard: ${decision.reason}`);
      }
    }

    const { snapshotId, promotedToLatest } = await writeSnapshot('trident', 'russell2k', {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      universeSize: scan.universeSize,
      results: scan.rows,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.trident,
      warnings,
      status,
      regime: scan.regime,
      stage1Survivors: scan.stage1Survivors,
    } as any);

    log.info('snapshot_written', {
      snapshotId, status, promotedToLatest,
      rows: scan.rows.length, survivors: scan.stage1Survivors,
      durationMs: Date.now() - started,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, snapshotId, status, rows: scan.rows.length }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('trident_scan_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
