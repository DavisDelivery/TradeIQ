// Scheduled scan: insider board, daily after US close.
//
// Schedule: "30 21 * * 1-5"  (21:30 UTC ≈ 17:30 ET, weekdays).
// Insider Form 4 filings update after-hours; daily refresh is plenty.
//
// Strategy: scan at the WIDEST window (180 days) and store the full filings
// array per row + EDGAR-enriched topBuyer roles. The live endpoint reads the
// snapshot, filters filings to the user's requested window (30/60/90/180),
// and re-aggregates buy/award/sell dollars on the fly. One snapshot per
// universe covers all 4 window variants without 4× the cost.

import { schedule } from '@netlify/functions';
import {
  runInsiderScan,
  INSIDER_SCHEDULED_WINDOW_DAYS,
  type InsiderUniverseKey,
} from './shared/scan-insider';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSES_TO_SCAN: Array<{ key: InsiderUniverseKey; storeKey: UniverseKey }> = [
  { key: 'sp500', storeKey: 'sp500' },
  { key: 'ndx', storeKey: 'ndx' },
  { key: 'dow', storeKey: 'dow' },
  { key: 'russell2k', storeKey: 'russell2k' },
];

export const handler = schedule('30 21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-insider' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', {
    board: 'insider',
    windowDays: INSIDER_SCHEDULED_WINDOW_DAYS,
  });

  const summary: any[] = [];
  for (const u of UNIVERSES_TO_SCAN) {
    const subLog = log.child({ universe: u.key });
    try {
      const scan = await runInsiderScan({
        universe: u.key,
        windowDays: INSIDER_SCHEDULED_WINDOW_DAYS,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        // Scheduled scans do role enrichment; live (capped) scans skip it.
        enrichRoles: true,
        logger: subLog,
      });

      const { snapshotId } = await writeSnapshot('insider', u.storeKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.rows,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.insider,
        warnings: scan.warnings,
      });

      subLog.info('snapshot_written', {
        snapshotId,
        rows: scan.rows.length,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
      });

      summary.push({
        universe: u.key,
        ok: true,
        rows: scan.rows.length,
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
