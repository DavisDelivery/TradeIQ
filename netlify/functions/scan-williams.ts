// Scheduled scan: williams board, every 30 min during US market hours.
// Williams (oversold/mean-reversion) is cheap per ticker — fits a full
// Russell 2K sweep comfortably inside the 14-min budget.

import { schedule } from '@netlify/functions';
import { runWilliamsScan, type WilliamsUniverseKey } from './shared/scan-williams';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSES_TO_SCAN: Array<{ key: WilliamsUniverseKey; storeKey: UniverseKey }> = [
  { key: 'sp500', storeKey: 'sp500' },
  { key: 'ndx', storeKey: 'ndx' },
  { key: 'dow', storeKey: 'dow' },
  { key: 'russell2k', storeKey: 'russell2k' },
];

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-williams' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'williams' });

  const summary: any[] = [];
  for (const u of UNIVERSES_TO_SCAN) {
    const subLog = log.child({ universe: u.key });
    try {
      const scan = await runWilliamsScan({
        universe: u.key,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 10,
        logger: subLog,
      });

      const { snapshotId } = await writeSnapshot('williams', u.storeKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.candidates,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.williams,
        warnings: scan.warnings,
      });

      subLog.info('snapshot_written', {
        snapshotId,
        candidates: scan.candidates.length,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
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
});
