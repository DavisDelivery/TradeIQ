// Scheduled scan: prophet board, every 30 min during US market hours.
//
// Schedule: "0,30 13-21 * * 1-5"
// Walks all 3 prophet universes (largecap, russell, all). Per-universe budget
// is 14 min, but in practice each runs 4–8 min thanks to the 7-API-fan-out
// per ticker. NO ANTHROPIC CALLS — narratives stay in the live endpoint.

import type { Handler } from '@netlify/functions';
import {
  runProphetScan,
  type ProphetUniverseKey,
} from '../shared/scan-prophet';
import {
  writeSnapshot,
  FRESHNESS_BUDGETS_MS,
  type UniverseKey,
} from '../shared/snapshot-store';
import { MODEL_VERSION } from '../shared/model-version';
import { logger } from '../shared/logger';

const PER_SCAN_BUDGET_MS = 14 * 60_000;

const UNIVERSES_TO_SCAN: Array<{ key: ProphetUniverseKey; storeKey: UniverseKey }> = [
  { key: 'largecap', storeKey: 'largecap' },
  { key: 'russell', storeKey: 'russell2k' },
  { key: 'all', storeKey: 'all' },
];

export const handler: Handler = async () => {
  const log = logger.child({ fn: 'scan-prophet' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'prophet' });

  const summary: any[] = [];
  for (const u of UNIVERSES_TO_SCAN) {
    const subLog = log.child({ universe: u.key });
    try {
      const scan = await runProphetScan({
        universe: u.key,
        // No scanCap — full sweep.
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 7,
        // No early-stop in scheduled mode — we want the full ranked list.
        sufficientQualified: Infinity,
        logger: subLog,
      });

      const { snapshotId } = await writeSnapshot('prophet', u.storeKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.picks,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
        warnings: scan.warnings,
      });

      subLog.info('snapshot_written', {
        snapshotId,
        picks: scan.picks.length,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
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
};
