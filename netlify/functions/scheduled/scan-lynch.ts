// Scheduled scan: lynch board, daily after US close.
// Schedule: "0 22 * * 1-5"  (22:00 UTC ≈ 18:00 ET, weekdays).
// Fundamentals don't move intraday; daily refresh is plenty.

import type { Handler } from '@netlify/functions';
import { runLynchScan, type LynchUniverseKey } from '../shared/scan-lynch';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from '../shared/snapshot-store';
import { MODEL_VERSION } from '../shared/model-version';
import { logger } from '../shared/logger';

const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSES_TO_SCAN: Array<{ key: LynchUniverseKey; storeKey: UniverseKey }> = [
  { key: 'sp500', storeKey: 'sp500' },
  { key: 'ndx', storeKey: 'ndx' },
  { key: 'dow', storeKey: 'dow' },
  { key: 'russell2k', storeKey: 'russell2k' },
];

export const handler: Handler = async () => {
  const log = logger.child({ fn: 'scan-lynch' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'lynch' });

  const summary: any[] = [];
  for (const u of UNIVERSES_TO_SCAN) {
    const subLog = log.child({ universe: u.key });
    try {
      const scan = await runLynchScan({
        universe: u.key,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        // Snapshot stores ALL candidates (no minConfidence filter at scan time).
        // Live endpoint can filter per request.
        minConfidence: 0,
        logger: subLog,
      });

      const { snapshotId } = await writeSnapshot('lynch', u.storeKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.candidates,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.lynch,
        warnings: scan.warnings,
      });

      subLog.info('snapshot_written', {
        snapshotId,
        candidates: scan.candidates.length,
        universeChecked: scan.universeChecked,
      });

      summary.push({
        universe: u.key,
        ok: true,
        candidates: scan.candidates.length,
        universeChecked: scan.universeChecked,
        durationMs: scan.scanDurationMs,
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      subLog.error('scan_failed', { err: msg });
      summary.push({ universe: u.key, ok: false, err: msg });
    }
  }

  log.info('scheduled_scan_complete', { totalMs: Date.now() - overallStart, summary });
  return { statusCode: 200, body: JSON.stringify({ ok: true, summary }) };
};
