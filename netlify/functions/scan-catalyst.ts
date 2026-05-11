// Scheduled scan: catalyst board, every 30 min during US market hours.
//
// Catalyst is the highest-value board for the small-cap discovery thesis —
// insider buying + congressional + contracts + setups stacked. Cap-relevant
// for fixing the silent A-G slice bug. Russell 2K full sweep runs ~10-12 min
// at concurrency 8 with Quiver/Finnhub free-tier rate limits.

import { schedule } from '@netlify/functions';
import { runCatalystScan, type CatalystUniverseKey } from './shared/scan-catalyst';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSES_TO_SCAN: Array<{ key: CatalystUniverseKey; storeKey: UniverseKey }> = [
  { key: 'sp500', storeKey: 'sp500' },
  { key: 'ndx', storeKey: 'ndx' },
  { key: 'dow', storeKey: 'dow' },
  { key: 'russell2k', storeKey: 'russell2k' },
];

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-catalyst' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'catalyst' });

  const summary: any[] = [];
  for (const u of UNIVERSES_TO_SCAN) {
    const subLog = log.child({ universe: u.key });
    try {
      const scan = await runCatalystScan({
        universe: u.key,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        logger: subLog,
      });

      // Snapshot stores ALL picks. Filter (cluster/patents/political/contracts
      // /setup) and minConviction apply at live-endpoint read time.
      const { snapshotId } = await writeSnapshot('catalyst', u.storeKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.picks,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.catalyst,
        warnings: scan.warnings,
      });

      subLog.info('snapshot_written', {
        snapshotId,
        picks: scan.picks.length,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
        budgetExceeded: scan.budgetExceeded,
      });

      summary.push({
        universe: u.key,
        ok: true,
        picks: scan.picks.length,
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
